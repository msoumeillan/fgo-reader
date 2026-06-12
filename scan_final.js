const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

// --- CONFIGURATION ---
const HEADLESS_MODE = false; // On garde la fenêtre visible
const BATCH_LIMIT = 99999;

async function run() {
  console.log("=== 🛠️ DÉMARRAGE SCAN FINAL (MODE COMPLET) ===");
  console.log("Ce script va charger les pages EN ENTIER pour ne rien rater.");

  let positionsDB = {};
  if (fs.existsSync("script_positions.json")) {
    try {
      positionsDB = JSON.parse(fs.readFileSync("script_positions.json"));
    } catch (e) {}
  }

  let history = new Set();
  if (fs.existsSync("scanned_history.txt")) {
    const lines = fs.readFileSync("scanned_history.txt", "utf-8").split("\n");
    lines.forEach((l) => {
      if (l.trim()) history.add(l.trim());
    });
  }

  console.log("📡 Récupération de la liste des quêtes...");
  const { data: wars } = await axios.get(
    "https://api.atlasacademy.io/export/NA/basic_war.json"
  );
  const targetWars = wars
    .filter((w) => w.id >= 100)
    .sort((a, b) => a.id - b.id);

  let targetScripts = [];

  // On ne prend que les 5 premières guerres pour tester le démarrage rapidement
  // Une fois que tu vois que ça marche, tu pourras laisser tourner pour tout le reste
  console.log("🔍 Construction de la liste des scripts...");

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
  console.log(`🎯 ${targetScripts.length} scripts à traiter.`);

  if (targetScripts.length === 0) return;

  // --- LANCEMENT NAVIGATEUR ---
  const browser = await puppeteer.launch({
    headless: HEADLESS_MODE,
    defaultViewport: null,
    args: ["--start-maximized"], // Fenêtre en grand
  });
  const page = await browser.newPage();

  // IMPORTANT : On NE bloque RIEN. On laisse tout charger.

  let processedCount = 0;

  for (const scriptId of targetScripts) {
    if (processedCount >= BATCH_LIMIT) break;
    processedCount++;

    const url = `https://apps.atlasacademy.io/db/NA/script/${scriptId}`;
    process.stdout.write(
      `\n[${processedCount}/${targetScripts.length}] Script ${scriptId}... `
    );

    try {
      // On attend que le réseau soit totalement calme (tout est chargé)
      await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

      // Petite sécurité : on attend que le sélecteur apparaisse
      try {
        await page.waitForSelector(".scene-figure-wrapper", { timeout: 5000 });
      } catch (e) {
        process.stdout.write(" (Pas de sprites)");
        fs.appendFileSync("scanned_history.txt", scriptId + "\n");
        continue;
      }

      // --- EXTRACTION ---
      const extracted = await page.evaluate(() => {
        const res = {};
        const wrappers = document.querySelectorAll(".scene-figure-wrapper");

        wrappers.forEach((wrapper) => {
          const face = wrapper.querySelector(".scene-figure-face");
          const body = wrapper.querySelector(".scene-figure");

          if (!body) return;

          // On cherche l'URL de l'image
          const bg = body.style.backgroundImage;
          // Regex pour trouver l'ID
          const m = bg.match(/\/(\d+)_merged\.png/);

          if (m) {
            const id = m[1];
            const val = (p) => parseFloat(p.replace("px", "")) || 0;

            // Si on a un visage, on prend !
            if (face) {
              res[id] = {
                x: val(face.style.left),
                y: val(face.style.top),
              };
            }
          }
        });
        return res;
      });

      const nbFound = Object.keys(extracted).length;

      if (nbFound > 0) {
        Object.assign(positionsDB, extracted);
        // SAUVEGARDE IMMÉDIATE
        fs.writeFileSync(
          "script_positions.json",
          JSON.stringify(positionsDB, null, 4)
        );
        process.stdout.write(` ✅ TROUVÉ (${nbFound} persos)`);
      } else {
        process.stdout.write(" ⚪ Vide");
      }

      fs.appendFileSync("scanned_history.txt", scriptId + "\n");
    } catch (err) {
      process.stdout.write(" ❌ Erreur");
    }
  }

  console.log("\nFINI.");
  await browser.close();
}

run();
