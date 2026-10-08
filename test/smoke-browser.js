const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--window-size=1280,720"],
  });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const shot = await page.screenshot({ encoding: "base64" });
  console.log("OK", browser.version(), shot.length);
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
