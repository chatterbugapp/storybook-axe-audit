#!/usr/bin/node

import * as path from 'path'

import puppetteer from 'puppeteer'
import * as yargs from 'yargs'
import serve from 'serve-handler'
import * as http from 'http'

const d = require('debug')('storybook-axe-audit')
const dv = require('debug')('storybook-axe-audit:verbose')

function waitForOneConsoleLine(frame: puppetteer.Page): Promise<string> {
  return new Promise((res) => {
    frame.once('console', (msg: puppetteer.ConsoleMessage) => res(msg.text()))
  })
}

let wat = 1
async function selectedTreeItemOffset(
  page: puppetteer.Page
): Promise<number | null> {
  const ret = await page.evaluate(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      (document.querySelector(
        '#storybook-explorer-tree [data-selected="true"]'
      ) as any)?.offsetTop
  )

  dv(`selected offset: ${ret}`)
  return ret ?? null
}

const FILTER_RE_LIST = [
  /contains a level-one heading/,
  /document has a main landmark/,
  /content is contained by landmarks/,
  /bypass navigation and jump straight/,
]

function filterInvalidWarnings(errorList: any[]) {
  return errorList.filter(
    (x) => !FILTER_RE_LIST.find((r) => r.test(x.description))
  )
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(() => res(true), ms))
}

async function screenshotIfFailed<T>(
  page: puppetteer.Page,
  block: () => Promise<T>
) {
  try {
    return await block()
  } catch (e) {
    await page.screenshot({ path: 'failed.png' })
    throw e
  }
}

async function checkStory(page: puppetteer.Page) {
  const iframe = page.frames().find((x) => x.url().match(/iframe/))
  if (!iframe) {
    throw new Error("Couldn't find story content!")
  }

  // NB: Figure out how to plumb errors from axe.run()
  await iframe.addScriptTag({ url: 'http://localhost:9876/axe.min.js' })
  await iframe.addScriptTag({
    content: 'window.axe.run().then(x => console.log(JSON.stringify(x)))',
  })

  const result = await waitForOneConsoleLine(page)
  const name = await page.evaluate(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      (document.querySelector(
        '#storybook-explorer-menu [data-selected="true"]'
      ) as any).id
  )

  // NB: I hate this so much
  for (let retry = 0; retry < 3; retry++) {
    let off = await selectedTreeItemOffset(page)
    await page.keyboard.press('ArrowRight', { delay: 150 })
    await page.keyboard.press('Enter', { delay: 150 })

    let newOff = await selectedTreeItemOffset(page)
    if (newOff && off !== newOff) {
      dv('right worked!')
      break
    }

    off = await selectedTreeItemOffset(page)
    await page.keyboard.press('ArrowDown', { delay: 150 })
    await page.keyboard.press('Enter', { delay: 150 })

    newOff = await selectedTreeItemOffset(page)
    if (newOff && off !== newOff) {
      dv('down worked!')
      break
    }
  }

  // NB: Wait for animations to clear or else we'll get false positives
  // about contrast
  await delay(1000)

  return { result, name }
}

function serveDirectory(dir: string) {
  d(`Serving directory: ${dir}`)
  const srv = http.createServer((req, resp) => {
    void serve(req, resp, { public: dir })
  })

  srv.listen(9876)
}

async function navigateToFirstStory(page: puppetteer.Page, port: number) {
  dv('Navigating')
  await page.goto(`http://localhost:${port}`)

  await page.waitForSelector(
    '#storybook-explorer-tree [data-nodetype="component"]'
  )

  await page.click('#storybook-explorer-tree .sidebar-item')

  for (let retries = 0; retries < 3; retries++) {
    await page.keyboard.press('ArrowDown', { delay: 150 })
    await page.keyboard.press('Enter', { delay: 150 })

    if (((await selectedTreeItemOffset(page)) ?? 0) > 0) {
      dv('down worked!')
      break
    }

    await page.keyboard.press('ArrowRight', { delay: 150 })
    await page.keyboard.press('Enter', { delay: 150 })

    if (((await selectedTreeItemOffset(page)) ?? 0) > 0) {
      dv('right worked!')
      break
    }
  }
}

export async function main(): Promise<number> {
  const argv = yargs
    .option('storybook', {
      describe:
        'Path to your compiled Storybook directory (create with build-storybook)',
      require: true,
      string: true,
    })
    .option('port', {
      describe: 'The port of the local internal HTTP server',
      default: 9876,
      number: true,
    })
    .option('screenshot', {
      describe: 'Dump screenshots of components that fail',
      boolean: true,
    })
    .option('screenshot-all', {
      describe: 'Dump screenshots of all components',
      boolean: true,
    })
    .help().argv

  d('Initializing browser')
  const browser = await puppetteer.launch()
  dv('new page!')
  const page = await browser.newPage()
  dv('viewport!')
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })

  serveDirectory(path.resolve(argv.storybook))
  await navigateToFirstStory(page, argv.port)

  let selectedOffset = -1
  d('Starting checks')
  while (true) {
    const { result, name } = await screenshotIfFailed(page, () =>
      checkStory(page)
    )

    if (argv['screenshot-all'])
      await page.screenshot({ path: `./screenshot-${name}.png` })

    try {
      const violations = filterInvalidWarnings(JSON.parse(result).violations)
      if (violations.length > 0) {
        dv(JSON.stringify(violations, null, 2))
        if (argv.screenshot)
          await page.screenshot({ path: `./failed-${name}.png` })

        console.log(`###\n### ${name}:\n###\n`)
        const violationMsgs = violations.map((v) => {
          const nodeMsgs = (v.nodes as any[]).map(
            (n) => `Summary: ${n.failureSummary}\n${n.html}\n`
          )

          return `Description: ${v.description}\n${nodeMsgs.join('\n')}`
        })

        console.log(violationMsgs.join('\n') + '\n')
      }
    } catch (e) {
      console.log(`Couldn't parse! ${result}`)
    }

    // NB: The selected item will cycle around back to the top of the page
    // once we arrow past the bottom
    const newSelectedOffset = await selectedTreeItemOffset(page)
    if (!newSelectedOffset) {
      throw new Error('We should always have an item here!')
    }

    if (selectedOffset > newSelectedOffset) {
      dv(`${selectedOffset} > ${newSelectedOffset}`)
      break
    } else {
      selectedOffset = newSelectedOffset
    }
  }

  return 0
}

if (require.main === module) {
  void main()
    .catch((ex: Error) => {
      console.error(ex.message)
      console.error(ex.stack)

      process.exit(-1)
    })
    .then((x) => process.exit(x))
}
