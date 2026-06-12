const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

// --- CONFIGURATION ---
const HEADLESS_MODE = false;
const BATCH_LIMIT = 99999;

// LISTE STRICTE DES CHAPITRES QUE TU VEUX SCANNER
const WHITELIST_IDS = [
  100,
  101,
  102,
  103,
  104,
  105,
  106,
  107,
  108, // Part 1 (Singularities)
  201,
  202,
  203,
  204, // Part 1.5 (Remnant)
  300,
  301,
  302,
  303,
  304,
  305,
  306,
  307,
  308,
  309,
  310,
  311, // Part 2 (Lostbelts)
];

async function run() {
  console.log("=== 🛠️ DÉMARRAGE SCAN CIBLÉ (MAIN STORY) ===");
  console.log("Cibles : Singularités + Lostbelts uniquement.");

  let positionsDB = {};
  if (fs.existsSync("script_positions_full.json")) {
    try {
      positionsDB = JSON.parse(fs.readFileSync("script_positions_full.json"));
    } catch (e) {}
  }

  let history = new Set();
  if (fs.existsSync("scanned_history_full.txt")) {
    const lines = fs
      .readFileSync("scanned_history_full.txt", "utf-8")
      .split("\n");
    lines.forEach((l) => {
      if (l.trim()) history.add(l.trim());
    });
  }

  console.log("📡 Récupération de la liste des guerres...");
  const { data: wars } = await axios.get(
    "https://api.atlasacademy.io/export/NA/basic_war.json"
  );

  // FILTRE MIS À JOUR : On ne garde que ceux qui sont dans la WHITELIST
  const targetWars = wars
    .filter((w) => WHITELIST_IDS.includes(w.id))
    .sort((a, b) => a.id - b.id);

  console.log(
    `✅ ${targetWars.length} Chapitres identifiés (de Fuyuki à LB7).`
  );

  let targetScripts = [];
  console.log("🔍 Récupération des scripts...");

  for (const war of targetWars) {
    try {
      const warDetailUrl = `https://api.atlasacademy.io/nice/NA/war/${war.id}`;
      const { data: warData } = await axios.get(warDetailUrl);

      if (warData.spots) {
        warData.spots.forEach((spot) => {
          if (spot.quests) {
            spot.quests.forEach((quest) => {
              if (quest.phaseScripts) {
                quest.phaseScripts.forEach((phase) => {
                  if (phase.scripts) {
                    phase.scripts.forEach((s) => {
                      if (!history.has(s.scriptId)) {
                        targetScripts.push(s.scriptId);
                      }
                    });
                  }
                });
              }
            });
          }
        });
      }
    } catch (e) {}
  }

  targetScripts = [...new Set(targetScripts)];
  console.log(`🎯 ${targetScripts.length} scripts à scanner.`);

  if (targetScripts.length === 0) {
    console.log("Tout est déjà scanné !");
    return;
  }

  // --- LANCEMENT NAVIGATEUR ---
  const browser = await puppeteer.launch({
    headless: HEADLESS_MODE,
    defaultViewport: null,
    args: ["--start-maximized"],
  });
  const page = await browser.newPage();

  let processedCount = 0;

  for (const scriptId of targetScripts) {
    if (processedCount >= BATCH_LIMIT) break;
    processedCount++;

    const url = `https://apps.atlasacademy.io/db/NA/script/${scriptId}`;
    process.stdout.write(
      `\n[${processedCount}/${targetScripts.length}] Script ${scriptId}... `
    );

    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

      try {
        await page.waitForSelector(".scene-figure-wrapper", { timeout: 5000 });
      } catch (e) {
        process.stdout.write(" (Pas de sprites)");
        fs.appendFileSync("scanned_history_full.txt", scriptId + "\n");
        continue;
      }

      // --- EXTRACTION COMPLÈTE ---
      const extracted = await page.evaluate(() => {
        const res = {};
        const wrappers = document.querySelectorAll(".scene-figure-wrapper");

        wrappers.forEach((wrapper) => {
          const figure = wrapper.querySelector(".scene-figure");
          const face = wrapper.querySelector(".scene-figure-face");

          if (!figure) return;

          const bg = figure.style.backgroundImage;
          const m = bg.match(/\/(\d+)_merged\.png/);

          if (m) {
            const id = m[1];
            const val = (p) => parseFloat(p.replace("px", "")) || 0;

            if (face) {
              res[id] = {
                id: id,
                body: {
                  left: val(figure.style.left),
                  bgSize: figure.style.backgroundSize,
                },
                face: {
                  x: val(face.style.left),
                  y: val(face.style.top),
                  width: val(face.style.width),
                  height: val(face.style.height),
                  bgPosition: face.style.backgroundPosition,
                  bgSize: face.style.backgroundSize,
                },
              };
            }
          }
        });
        return res;
      });

      const nbFound = Object.keys(extracted).length;

      if (nbFound > 0) {
        Object.assign(positionsDB, extracted);
        fs.writeFileSync(
          "script_positions_full.json",
          JSON.stringify(positionsDB, null, 4)
        );
        process.stdout.write(` ✅ AJOUTÉ (${nbFound} persos)`);
      } else {
        process.stdout.write(" ⚪ Vide");
      }

      fs.appendFileSync("scanned_history_full.txt", scriptId + "\n");
    } catch (err) {
      process.stdout.write(" ❌ Erreur");
    }
  }

  console.log("\nFIN DU SCAN.");
  await browser.close();
}

run();
