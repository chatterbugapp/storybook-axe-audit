import * as path from 'path'
import puppetteer from 'puppeteer'

import serve from 'serve-handler'
import * as http from 'http'

const ROOT_DIR = path.resolve(__dirname, '..')

function waitForOneConsoleLine(frame: puppetteer.Page): Promise<string> {
  return new Promise((res) => {
    frame.once('console', (msg: puppetteer.ConsoleMessage) => res(msg.text()))
  })
}

function selectedTreeItemOffset(page: puppetteer.Page): Promise<number> {
  return page.evaluate(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      (document.querySelector(
        '#storybook-explorer-menu [data-selected="true"]'
      ) as any).offsetTop
  )
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

async function checkStory(page: puppetteer.Page) {
  const iframe = page.frames().find((x) => x.url().match(/iframe/))!

  await iframe.addScriptTag({ url: 'http://localhost:9876/axe.min.js' })
  await iframe.addScriptTag({
    content: 'window.axe.run().then(x => { console.log(JSON.stringify(x)) })',
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
    await page.keyboard.press('ArrowRight', { delay: 50 })
    await page.keyboard.press('Enter', { delay: 50 })

    if (off !== (await selectedTreeItemOffset(page))) {
      break
    }

    off = await selectedTreeItemOffset(page)
    await page.keyboard.press('ArrowDown', { delay: 50 })
    await page.keyboard.press('Enter', { delay: 50 })

    if (off !== (await selectedTreeItemOffset(page))) {
      break
    }
  }

  return { result, name }
}

export async function main(): Promise<number> {
  const srv = http.createServer((req, resp) => {
    void serve(req, resp, {
      public: path.resolve(ROOT_DIR, 'storybook-static'),
    })
  })

  srv.listen(9876)

  const browser = await puppetteer.launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })

  await page.goto('http://localhost:9876')

  await page.waitForSelector('#components-flag')
  await page.click('#storybook-explorer-menu button')

  await page.keyboard.press('Enter')

  await page.keyboard.press('ArrowDown', { delay: 50 })
  await page.keyboard.press('ArrowRight', { delay: 50 })
  await page.keyboard.press('Enter', { delay: 50 })

  let i = 0
  let selectedOffset = -1
  while (true) {
    const { result, name } = await checkStory(page)
    //await page.screenshot({ path: `./screenshot${i}.png` })

    try {
      const violations = filterInvalidWarnings(JSON.parse(result).violations)
      if (violations.length > 0) {
        console.log(`###\n### ${name}:\n###\n`)
        //console.log(JSON.stringify(violations, null, 2))
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

    i++

    // NB: The selected item will cycle around back to the top of the page
    // once we arrow past the bottom
    const newSelectedOffset = await selectedTreeItemOffset(page)
    if (selectedOffset > newSelectedOffset) {
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
