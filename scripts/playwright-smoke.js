/**
 * Playwright smoke test for the Hifz Tester UI.
 * Uses window.__testReport hook to inject a mock report without audio.
 */

const { chromium } = require("playwright");

const mockReport = {
  surah: 1,
  fromAyah: 1,
  toAyah: 2,
  transcript: "bismi allahi arrahmani arraheem alhamdu lillahi rabbi alAAalameen",
  allClean: true,
  summary: "Lesson complete — every ayah in range was clean. Proceed to the next chunk.",
  ayahs: [
    {
      surah: 1,
      ayah: 1,
      text: "بِسْمِ اللَّهِ الرَّحْمَـٰنِ الرَّحِيمِ",
      clean: true,
      notes: [],
      translation: "In the name of Allah, the Entirely Merciful, the Especially Merciful.",
      transliteration:
        '<span class="tajweed-em">B</span>ismi <span class="tajweed-em">A</span>ll<span class="tajweed-em">a</span>hi a<span class="tajweed-heavy">l</span>rra<span class="tajweed-em">h</span>m<span class="tajweed-em">a</span>ni a<span class="tajweed-heavy">l</span>rra<span class="tajweed-em">h</span>eem<span class="tajweed-heavy">i</span>',
    },
    {
      surah: 1,
      ayah: 2,
      text: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
      clean: true,
      notes: [],
      translation: "[All] praise is [due] to Allah, Lord of the worlds -",
      transliteration:
        '<span class="tajweed-em">A</span>l<span class="tajweed-em">h</span>amdu lill<span class="tajweed-em">a</span>hi rabbi al<span class="tajweed-em">AA</span><span class="tajweed-em">a</span>lameen<span class="tajweed-heavy">a</span>',
    },
  ],
  nextWord: {
    surah: 1,
    ayah: 3,
    wordIndex: 0,
    text: "الرَّحْمَـٰنِ",
    transliteration: '<span class="tajweed-heavy">A</span>lrra<span class="tajweed-em">h</span>m<span class="tajweed-em">a</span>ni',
  },
};

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Inject mock report before page scripts run
  await context.addInitScript((report) => {
    window.__testReport = report;
  }, mockReport);

  await page.goto("http://localhost:3001");

  // 1. Verify dropdown label
  await page.waitForFunction(() => {
    const sel = document.querySelector("select");
    return sel && sel.options.length > 1;
  });
  const optionText = await page.locator("select").first().locator('option[value="1"]').textContent();
  console.log("Dropdown option:", optionText?.trim());
  if (!optionText?.includes("Al-Fatihah") || !optionText?.includes("The Opening")) {
    throw new Error("Dropdown missing expected surah info");
  }

  // Wait for report to render via __testReport hook
  await page.waitForSelector(".report-head", { timeout: 10000 });

  // 2. Verify report header
  const header = await page.locator(".report-head").textContent();
  console.log("Report header:", header);
  if (!header?.includes("الفاتحة")) throw new Error("Missing Arabic name");
  if (!header?.includes("Al-Fatihah")) throw new Error("Missing English name");
  if (!header?.includes("The Opening")) throw new Error("Missing meaning");
  if (!header?.includes("Meccan")) throw new Error("Missing revelation badge");

  // 3. Verify per-ayah translation and transliteration
  const translations = await page.locator(".ayah-translation").allTextContents();
  console.log("Translations:", translations);
  if (translations.length !== 2) throw new Error("Expected 2 translations");
  if (!translations[0].includes("In the name of Allah")) throw new Error("Missing ayah 1 translation");

  const transliterations = await page.locator(".ayah-transliteration").allInnerTexts();
  console.log("Transliterations count:", transliterations.length);
  if (transliterations.length !== 2) throw new Error("Expected 2 transliterations");

  // Verify transliteration contains sanitized spans
  const firstTranslitHTML = await page.locator(".ayah-transliteration").first().innerHTML();
  if (!firstTranslitHTML.includes('class="tajweed-em"')) {
    throw new Error("Transliteration missing tajweed spans");
  }

  // 4. Verify luqma panel transliteration
  await page.locator('details:has-text("Stuck? Show next word") summary').click();
  await page.waitForTimeout(200);
  const luqmaTranslit = await page.locator(".luqma-translit").innerHTML();
  console.log("Luqma translit:", luqmaTranslit);
  if (!luqmaTranslit.includes('class="tajweed-heavy"')) {
    throw new Error("Luqma transliteration missing tajweed spans");
  }

  console.log("\n✅ All Playwright smoke tests passed!");
  await browser.close();
}

run().catch((e) => {
  console.error("❌ Playwright test failed:", e.message);
  process.exit(1);
});
