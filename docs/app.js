// ============================================================
// FGO Reader — version 100% navigateur (API Atlas Academy)
// ============================================================
const API = "https://api.atlasacademy.io";
const ASSETS = "https://static.atlasacademy.io";
const REGION = "NA";

// ------------------------------------------------------------
// Données : chapitres / quêtes
// ------------------------------------------------------------
let wars = [];               // liste légère (basic_war)
const warDetailCache = {};   // warId -> détail nice (spots, quests, banner)

async function fetchWars() {
  const r = await fetch(`${API}/export/${REGION}/basic_war.json`);
  const data = await r.json();
  return data
    .filter((w) => w.longName)
    .sort((a, b) => a.id - b.id)
    .map((w) => ({ id: w.id, longName: w.longName }));
}

async function fetchWarDetail(warId) {
  if (warDetailCache[warId]) return warDetailCache[warId];
  const r = await fetch(`${API}/nice/${REGION}/war/${warId}`);
  const w = await r.json();
  const detail = { id: w.id, longName: w.longName, banner: w.banner, spots: w.spots || [] };
  warDetailCache[warId] = detail;
  return detail;
}

// ------------------------------------------------------------
// Position / géométrie des sprites (table svtScript du jeu)
// ------------------------------------------------------------
const figureInfoCache = {};

function getImageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1024, height: 1024 });
    img.src = url;
  });
}

async function fetchFigureInfo(charId) {
  if (charId in figureInfoCache) return figureInfoCache[charId];
  let result = null;
  try {
    const r = await fetch(`${API}/raw/${REGION}/svtScript?charaId=${charId}`);
    if (!r.ok) { figureInfoCache[charId] = null; return null; }
    const data = await r.json();
    const s = Array.isArray(data) ? data[0] : null;
    if (s) {
      const ext = s.extendData || {};
      const w = ext.faceSizeRect ? ext.faceSizeRect[0] : ext.faceSize || 256;
      const h = ext.faceSizeRect ? ext.faceSizeRect[1] : ext.faceSize || 256;

      // Dimensions réelles du PNG de base : seulement utile pour les
      // visages non standard (figures spéciales, rares)
      let figureWidth = 1024;
      let figureHeight = 1024;
      if (w !== 256 || h !== 256) {
        const size = await getImageSize(`${ASSETS}/${REGION}/CharaFigure/${charId}/${charId}.png`);
        figureWidth = size.width;
        figureHeight = size.height;
      }

      // Cas standard : visages 256px, image de base 1024 de haut dont la
      // bande du bas (à partir de 768) contient la 1ère rangée de visages
      const standard = w === 256 && h === 256 && figureHeight === 1024;
      result = {
        faceX: s.faceX, faceY: s.faceY, w, h,
        figureWidth, figureHeight,
        offsetX: s.offsetX || 0, offsetY: s.offsetY || 0,
        bodyHeight: standard ? 768 : figureHeight,
        standard,
      };
    }
    figureInfoCache[charId] = result;
  } catch (e) { /* erreur réseau : on ne mémorise pas l'échec */ }
  return result;
}

// ------------------------------------------------------------
// Parsing des scripts du jeu
// ------------------------------------------------------------

// Nettoie une ligne de dialogue : tags de mise en forme, nom du joueur,
// texte genré [&masculin:féminin], ruby [#texte:lecture], noms cachés…
function cleanDialogueText(text) {
  return text
    .replace(/\[%1\]/g, "Fujimaru")
    .replace(/\[line\s*\d*\]/g, "——")
    .replace(/\[&(?:[^\[\]]|\[[^\]]*\])*\]/g, (m) => {
      const inner = m.slice(2, -1);
      return inner.split(/:(?=[^\]]*(?:\[|$))/)[0];
    })
    .replace(/\[#([^:\]]*):[^\]]*\]/g, "$1")
    .replace(/\[servantName\s+[^:\]]*:([^:\]]*):[^\]]*\]/g, "$1")
    .replace(/\[(?:r|sr|csr)\]/g, " ")
    .replace(/\[.*?\]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

async function fetchQuestScript(questId) {
  const qRes = await fetch(`${API}/nice/${REGION}/quest/${questId}`);
  const data = await qRes.json();

  let scriptUrls = [];
  if (data.phaseScripts) {
    data.phaseScripts.forEach((p) => {
      if (p.scripts) p.scripts.forEach((s) => scriptUrls.push(s.script));
    });
  }
  if (scriptUrls.length === 0) return [];

  let combinedScript = [];

  // --- ÉTAT GLOBAL (persos)
  let speakerState = {}; // ex: A -> {name,url,currentFace}
  let nameToCode = {};   // ex: "Mash" -> "A"

  for (const url of scriptUrls) {
    try {
      const textRes = await fetch(url);
      const rawText = await textRes.text();
      const lines = rawText.split("\n");

      let lastBackground = null;
      let lastBgm = null;

      let currentSpeakerName = null;
      let currentSpeakerCode = null;
      let pendingChoices = null;
      let stepBuffer = [];
      let visibleChars = new Set();
      let lastShownCode = null; // code du perso actuellement affiché par le lecteur
      let commActive = null;    // appel vidéo en cours : { url, face }

      for (let line of lines) {
        line = (line || "").trim();
        if (!line || line.startsWith("$") || line.startsWith("＄")) continue;

        // Choix : ？N：texte (avec éventuelle info de route ？N,x,y：texte)
        // — déclare le choix ET marque le début de sa branche
        const choiceMatch = line.match(/^？(\d+)[^：:]*[：:](.+)$/);
        if (choiceMatch) {
          if (!pendingChoices) pendingChoices = [];
          pendingChoices.push(cleanDialogueText(choiceMatch[2]));
          stepBuffer.push({ __branch: parseInt(choiceMatch[1]) });
          continue;
        }

        // ？！ : fin d'un bloc choix
        if (line === "？！") {
          if (pendingChoices) {
            const firstBranch = stepBuffer.findIndex(s => s.__branch !== undefined);
            // Contenu avant les choix → directement dans combinedScript
            if (firstBranch > 0) combinedScript.push(...stepBuffer.slice(0, firstBranch));
            // Découper les branches
            const branchPart = firstBranch >= 0 ? stepBuffer.slice(firstBranch) : [];
            const segments = [[]];
            for (const s of branchPart) {
              if (s.__branch !== undefined) segments.push([]);
              else segments[segments.length - 1].push(s);
            }
            combinedScript.push({
              choices: pendingChoices.map((text, i) => ({ text, steps: segments[i + 1] || [] }))
            });
            stepBuffer = [];
            pendingChoices = null;
          } else {
            combinedScript.push(...stepBuffer.filter(s => !s.__branch));
            stepBuffer = [];
          }
          continue;
        }

        // Marqueur de branche standalone ？N (sans deux-points)
        const branchSwitch = line.match(/^？(\d+)$/);
        if (branchSwitch) {
          stepBuffer.push({ __branch: parseInt(branchSwitch[1]) });
          continue;
        }

        let step = {};

        // 0) communicationChara / Loop : appel vidéo (sprite spécial bleu
        // 98003xxx + effet transparence/scanlines). Le dernier nombre = visage.
        const commMatch = line.match(/communicationChara(?:Loop)?\s+([0-9]+)((?:\s+\d+)*)\s*\]/);
        if (commMatch) {
          const charId = commMatch[1];
          const extra = commMatch[2].trim().split(/\s+/).filter(Boolean).map(Number);
          const face = extra.length ? extra[extra.length - 1] : 0;
          commActive = { url: `${ASSETS}/${REGION}/CharaFigure/${charId}/${charId}_merged.png`, face };
          step.showChar = { url: commActive.url, face: commActive.face, comm: true };
          lastShownCode = null;
          stepBuffer.push(step);
          continue;
        }
        // communicationCharaFace N : change l'expression dans l'appel
        const commFaceMatch = line.match(/communicationCharaFace\s+([0-9]+)/);
        if (commFaceMatch) {
          if (commActive) {
            commActive.face = parseInt(commFaceMatch[1], 10);
            step.showChar = { url: commActive.url, face: commActive.face, comm: true };
            stepBuffer.push(step);
          }
          continue;
        }
        // communicationCharaClear : fin de l'appel
        if (line.includes("communicationCharaClear")) {
          commActive = null;
          step.hideChar = true;
          stepBuffer.push(step);
          continue;
        }

        // 1) charaSet : [charaSet A 98001000 0 Mash]
        const charaMatch = line.match(
          /charaSet\s+([a-zA-Z0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.+?)(?:\]|$)/
        );
        if (charaMatch) {
          const code = charaMatch[1];
          const charID = charaMatch[2];
          const baseFace = parseInt(charaMatch[3], 10);
          const charName = charaMatch[4].replace(/"/g, "").trim();

          speakerState[code] = {
            name: charName,
            url: `${ASSETS}/${REGION}/CharaFigure/${charID}/${charID}_merged.png`,
            currentFace: Number.isFinite(baseFace) ? baseFace : 0,
          };
          if (charName && charName !== "???") {
            nameToCode[charName] = code;
          }
          continue;
        }

        // 1b) charaChange : [charaChange A 98001001 0 ...] — change le sprite
        // d'un perso déjà déclaré (tenue, forme...), le nom est conservé
        const changeMatch = line.match(
          /charaChange\s+([a-zA-Z0-9]+)\s+([0-9]+)\s+([0-9]+)/
        );
        if (changeMatch) {
          const code = changeMatch[1];
          const charID = changeMatch[2];
          const baseFace = parseInt(changeMatch[3], 10);
          const prev = speakerState[code];
          speakerState[code] = {
            name: prev ? prev.name : code,
            url: `${ASSETS}/${REGION}/CharaFigure/${charID}/${charID}_merged.png`,
            currentFace: Number.isFinite(baseFace) ? baseFace : 0,
          };
          continue;
        }

        // 2) charaFace / charaFaceFade : [charaFace A 12], [charaFaceFade A 12 0.2]
        const faceMatch = line.match(/charaFace(?:Fade)?\s+([a-zA-Z0-9]+)\s+([0-9]+)/);
        if (faceMatch) {
          const code = faceMatch[1];
          const newFace = parseInt(faceMatch[2], 10);
          if (speakerState[code] && Number.isFinite(newFace)) {
            speakerState[code].currentFace = newFace;
          }
          continue;
        }

        // 2b) charaFadeout : personnage qui disparaît
        const fadeoutMatch = line.match(/charaFadeout\s+([a-zA-Z0-9]+)/);
        if (fadeoutMatch) {
          visibleChars.delete(fadeoutMatch[1]);
          if (visibleChars.size === 0) {
            step.hideChar = true;
            lastShownCode = null;
          }
        }

        // 2c) charaFadein / charaPut : personnage qui devient visible.
        // On l'affiche dès son entrée en scène (il reste affiché si un autre
        // perso parle hors écran, ex. Romani en communication).
        // NB : [charaTalk X] est un simple effet de focus, PAS une apparition
        const fadeinMatch = line.match(/chara(?:Fadein|Put(?:FSR)?)\s+([a-zA-Z0-9]+)/);
        if (fadeinMatch) {
          const inCode = fadeinMatch[1];
          visibleChars.add(inCode);
          if (speakerState[inCode]) {
            step.showChar = {
              url: speakerState[inCode].url,
              face: speakerState[inCode].currentFace,
            };
            lastShownCode = inCode;
          }
        }

        // 2d) charaCrossFade A B : A est remplacé par B à l'écran
        const crossMatch = line.match(/charaCrossFade\s+([a-zA-Z0-9]+)\s+([a-zA-Z0-9]+)/);
        if (crossMatch) {
          visibleChars.delete(crossMatch[1]);
          const inCode = crossMatch[2];
          visibleChars.add(inCode);
          if (speakerState[inCode]) {
            step.showChar = {
              url: speakerState[inCode].url,
              face: speakerState[inCode].currentFace,
            };
            lastShownCode = inCode;
          }
        }

        // 3) background: [scene 10310] etc.
        const sceneMatch = line.match(/scene[, ]+([0-9]+)/);
        const backMatch = line.match(/(back[0-9]+)/);
        const bgMatch = line.match(/(bg_[a-zA-Z0-9_]+)/);

        let foundBg = null;
        if (sceneMatch)
          foundBg = `${ASSETS}/${REGION}/Back/back${sceneMatch[1]}.png`;
        else if (backMatch)
          foundBg = `${ASSETS}/${REGION}/Back/${backMatch[1]}.png`;
        else if (bgMatch)
          foundBg = `${ASSETS}/${REGION}/Bg/${bgMatch[1]}.png`;

        if (foundBg && foundBg !== lastBackground) {
          step.background = foundBg;
          lastBackground = foundBg;
          // Un changement de décor réinitialise la scène : les persos
          // doivent être ré-introduits par charaFadein dans le script
          visibleChars.clear();
          lastShownCode = null;
          commActive = null;
          step.hideChar = true;
        }

        // 4) BGM
        const bgmMatch = line.match(/bgm[ ]+([^ \]]+)/);
        const bgmStop = line.includes("bgmStop") || line.includes("soundStopAll");
        if (bgmStop) step.stopBgm = true;
        else if (bgmMatch) {
          const bgmName = bgmMatch[1];
          const bgmUrl = `${ASSETS}/${REGION}/Audio/Bgm/${bgmName}/${bgmName}.mp3`;
          if (bgmUrl !== lastBgm) {
            step.bgm = bgmUrl;
            lastBgm = bgmUrl;
          }
        }

        // 4b) Sound effects: [se ad13] — le dossier dépend du préfixe du fichier
        const seMatch = line.match(/\[se\s+([a-zA-Z0-9_]+)/);
        if (seMatch) {
          const seName = seMatch[1];
          const prefix = seName.slice(0, 2);
          const seFolder =
            prefix === "ba" ? "Battle" :
            prefix === "ar" ? "ResidentSE" :
            prefix === "21" ? "SE_21" : "SE";
          step.se = `${ASSETS}/${REGION}/Audio/${seFolder}/${seName}.mp3`;
        }

        // 5) Speaker lines: "＠A：???" ou "＠Mash"
        if (line.startsWith("@") || line.startsWith("＠")) {
          const raw = cleanDialogueText(line.substring(1));

          // Format code + nom: "A：???" ou "A:???"
          const m = raw.match(/^([A-Za-z0-9]+)\s*[：:]\s*(.+)$/);

          if (m) {
            currentSpeakerCode = m[1].trim();
            currentSpeakerName = m[2].trim();
          } else {
            currentSpeakerCode = null;
            currentSpeakerName = raw;
          }
          continue;
        }

        // 6) Dialogue text (ligne normale, pas commande)
        if (!line.startsWith("[") && currentSpeakerName) {
          const cleanText = cleanDialogueText(line);
          if (cleanText.length > 0) {
            step.talk = {
              speakerName: currentSpeakerName,
              detail: cleanText,
            };

            // Priorité au code
            let code = currentSpeakerCode;

            // fallback via nom (si le code absent)
            if (!code) code = nameToCode[currentSpeakerName];

            // Priorité au perso réellement à l'écran quand c'est lui qui parle
            // (charaFadein). Un perso qui parle hors écran (narration...) ne
            // doit rien afficher.
            if (code && speakerState[code] && visibleChars.has(code)) {
              step.figure = {
                url: speakerState[code].url,
                face: speakerState[code].currentFace,
              };
              lastShownCode = code;
            }
            // Sinon, si un appel vidéo est en cours, on affiche le perso appelé
            // (effet visio) — typiquement Romani en communication
            else if (commActive) {
              step.figure = { url: commActive.url, face: commActive.face, comm: true };
            } else if (lastShownCode && !visibleChars.has(lastShownCode)) {
              // Le perso encore affiché par le lecteur a quitté la scène
              step.hideChar = true;
              lastShownCode = null;
            }
          }
        }

        if (Object.keys(step).length > 0) stepBuffer.push(step);
      }
      // Flush le buffer restant à la fin du script
      combinedScript.push(...stepBuffer.filter(s => !s.__branch));
      stepBuffer = [];
    } catch (err) {
      console.error(`Erreur lecture script: ${err.message}`);
    }
  }

  return combinedScript;
}

// ------------------------------------------------------------
// Compositor : placement des sprites comme dans le jeu
// (scène de 1024x576, offsets officiels, planche de visages)
// ------------------------------------------------------------
let lastFigure = null;

const Compositor = {
  async update(url, faceIndex, isComm = false) {
    const container = document.getElementById('char-container');
    const bodyDiv = document.getElementById('char-body');
    const faceDiv = document.getElementById('char-face');
    const scan = document.getElementById('char-scanlines');
    const match = url.match(/\/([0-9]+)_merged\.png/);
    const charID = match ? match[1] : null;
    const info = charID ? await fetchFigureInfo(charID) : null;
    lastFigure = { url, faceIndex, isComm };

    // En paysage : calé sur la hauteur (comme le jeu). En portrait : on
    // réduit pour que le buste (~420px au centre du canvas) tienne en largeur
    const S = Math.min(window.innerHeight / 576, window.innerWidth / 420);
    container.style.width = `${1024 * S}px`;
    container.style.height = `${window.innerHeight}px`;

    const figW = info ? info.figureWidth : 1024;
    const offY = info ? info.offsetY : 0;
    const bodyH = info ? info.bodyHeight : 768;
    const bodyLeft = ((1024 - figW) / 2 + (info ? info.offsetX : 0)) * S;

    // Position verticale du corps. Les sprites de communication (visio) sont
    // dessinés bien plus haut dans leur image (faceY ~21 au lieu de ~149) :
    // avec le même offsetY que d'habitude la tête sortirait de l'écran. On
    // recentre donc en fonction du faceY (sans effet sur les figures normales
    // dont faceY vaut déjà ~149).
    const STD_FACE_Y = 149;
    let bodyTopPx = -offY * S;
    if (isComm && info) bodyTopPx += (STD_FACE_Y - info.faceY) * S;

    bodyDiv.style.backgroundImage = `url("${url}")`;
    bodyDiv.style.width = `${figW * S}px`;
    bodyDiv.style.height = `${bodyH * S}px`;
    bodyDiv.style.left = `${bodyLeft}px`;
    bodyDiv.style.top = `${bodyTopPx}px`;
    bodyDiv.style.backgroundSize = `${figW * S}px auto`;

    // Effet "appel vidéo" : transparence (via classe) + calque de scanlines
    // calé sur la boîte du corps
    if (isComm) {
      container.classList.add('comm');
      scan.style.left = `${bodyLeft}px`;
      scan.style.top = `${bodyTopPx}px`;
      scan.style.width = `${figW * S}px`;
      scan.style.height = `${bodyH * S}px`;
      scan.style.display = 'block';
    } else {
      container.classList.remove('comm');
      scan.style.display = 'none';
    }

    const face = parseInt(faceIndex);
    if (!info || !Number.isFinite(face) || face <= 0) {
      faceDiv.style.display = 'none';
      container.style.display = 'block';
      return;
    }
    const imageIndex = face - 1;
    const perRow = Math.max(1, Math.floor(1024 / info.w));
    const col = imageIndex % perRow;
    const row = Math.floor(imageIndex / perRow);
    let sheetY;
    if (info.standard) {
      sheetY = 768 + 256 * row;
    } else {
      const page = Math.floor(row / perRow);
      sheetY = info.figureHeight + 1024 * page + (row % perRow) * info.h;
    }
    faceDiv.style.backgroundImage = `url("${url}")`;
    faceDiv.style.width = `${info.w * S}px`;
    faceDiv.style.height = `${info.h * S}px`;
    faceDiv.style.left = `${info.faceX * S + bodyLeft}px`;
    faceDiv.style.top = `${bodyTopPx + info.faceY * S}px`;
    faceDiv.style.backgroundSize = `${figW * S}px auto`;
    faceDiv.style.backgroundPosition = `${-(col * info.w * S)}px ${-(sheetY * S)}px`;
    faceDiv.style.display = 'block';
    container.style.display = 'block';
  }
};
window.addEventListener('resize', () => {
  if (lastFigure && document.getElementById('char-container').style.display === 'block') {
    Compositor.update(lastFigure.url, lastFigure.faceIndex, lastFigure.isComm);
  }
});

// ------------------------------------------------------------
// UI : menus + lecteur
// ------------------------------------------------------------
let sc = [], idx = 0, isProcessing = false, currentQuestId = null, selectedQuestId = null;
let currentWarDetail = null;
const audio = document.getElementById('bgm-player');
const seAudio = document.getElementById('se-player');
audio.volume = 0.5;
seAudio.volume = 0.8;

async function init() {
  try {
    wars = await fetchWars();
    buildChapterGrid();
  } catch (e) {
    document.getElementById('ch-subtitle').textContent = "Erreur de chargement — vérifie ta connexion puis recharge";
  }
}

function bannerUrl(warId) {
  if (warId >= 1001 && warId <= 1006) {
    return `${ASSETS}/${REGION}/Banner/chaldea_category_${warId}.png`;
  }
  return `${ASSETS}/${REGION}/Banner/questboard_cap${warId}.png`;
}

function buildChapterGrid() {
  const grid = document.getElementById('chapter-grid');
  grid.innerHTML = '';
  wars.forEach(war => {
    const card = document.createElement('div');
    card.className = 'war-card';
    card.onclick = () => showQuestScreen(war);

    const img = document.createElement('img');
    img.src = bannerUrl(war.id);
    img.alt = '';
    img.loading = 'lazy';
    let triedRealBanner = false;
    img.onerror = async function() {
      // L'URL devinée a échoué : on demande la vraie bannière à l'API
      if (!triedRealBanner) {
        triedRealBanner = true;
        try {
          const detail = await fetchWarDetail(war.id);
          if (detail.banner) { this.src = detail.banner; return; }
        } catch (e) {}
      }
      this.remove();
      const fb = document.createElement('div');
      fb.className = 'war-card-fallback';
      fb.textContent = war.longName.split('\n')[0];
      card.insertBefore(fb, card.firstChild);
    };

    const name = document.createElement('div');
    name.className = 'war-card-name';
    name.textContent = war.longName.replace(/\n/g, ' ');

    card.appendChild(img);
    card.appendChild(name);
    grid.appendChild(card);
  });
}

function showChapterScreen() {
  document.getElementById('quest-screen').style.display = 'none';
  document.getElementById('chapter-screen').style.display = 'flex';
}

async function showQuestScreen(war) {
  selectedQuestId = null;
  document.getElementById('chapter-screen').style.display = 'none';
  const qs = document.getElementById('quest-screen');
  qs.style.display = 'flex';

  document.getElementById('quest-war-title').textContent = war.longName.replace(/\n/g, ' ');
  const container = document.getElementById('quest-list-container');
  container.innerHTML = '<div class="quest-loading">Chargement…</div>';
  document.getElementById('quest-log').textContent = '';

  let detail;
  try {
    detail = await fetchWarDetail(war.id);
  } catch (e) {
    container.innerHTML = '<div class="quest-loading">Erreur de chargement.</div>';
    return;
  }
  currentWarDetail = detail;

  const banner = document.getElementById('quest-war-banner');
  banner.style.display = 'block';
  banner.src = detail.banner || bannerUrl(war.id);
  banner.onerror = () => { banner.style.display = 'none'; };

  container.innerHTML = '';

  const makeItem = (quest) => {
    const item = document.createElement('div');
    item.className = 'quest-item';
    item.textContent = quest.name;
    item.onclick = () => {
      selectedQuestId = quest.id;
      go();
    };
    return item;
  };

  // Remonte en haut les quêtes-charnières d'histoire (prologue / intro / outro),
  // souvent enterrées tout en bas de la liste, surtout dans les Lostbelts.
  const isBridge = (name) => /^(prologue|intro|outro)/i.test(name || '');
  const bridge = [];
  detail.spots.forEach(spot => (spot.quests || []).forEach(q => { if (isBridge(q.name)) bridge.push(q); }));
  if (bridge.length) {
    // prologue/intro d'abord, puis outro, puis par identifiant
    bridge.sort((a, b) => {
      const pa = /^outro/i.test(a.name) ? 1 : 0, pb = /^outro/i.test(b.name) ? 1 : 0;
      return pa - pb || a.id - b.id;
    });
    const group = document.createElement('div');
    group.className = 'spot-group';
    const sn = document.createElement('div');
    sn.className = 'spot-name';
    sn.textContent = 'Prologue / Intro';
    group.appendChild(sn);
    bridge.forEach(quest => group.appendChild(makeItem(quest)));
    container.appendChild(group);
  }
  const movedIds = new Set(bridge.map(q => q.id));

  detail.spots.forEach(spot => {
    const quests = (spot.quests || []).filter(q => !movedIds.has(q.id));
    if (quests.length === 0) return;
    const group = document.createElement('div');
    group.className = 'spot-group';
    if (spot.name) {
      const sn = document.createElement('div');
      sn.className = 'spot-name';
      sn.textContent = spot.name;
      group.appendChild(sn);
    }
    quests.forEach(quest => group.appendChild(makeItem(quest)));
    container.appendChild(group);
  });
}

function allQuests() {
  if (!currentWarDetail) return [];
  return currentWarDetail.spots.flatMap(s => (s.quests || []).map(q => ({ ...q })));
}
function nextQuest() {
  const all = allQuests();
  const i = all.findIndex(q => String(q.id) === String(currentQuestId));
  return i >= 0 && i + 1 < all.length ? all[i + 1] : null;
}

function toggleOptions() { document.getElementById('options-overlay').classList.toggle('active'); }
function setVolume(v) { audio.volume = v / 100; document.getElementById('vol-val').textContent = v + '%'; }

async function loadQuest(id) {
  currentQuestId = id;
  document.getElementById('end-overlay').classList.remove('active');
  audio.src = '';
  audio.load();
  let script;
  try {
    script = await fetchQuestScript(id);
  } catch (e) {
    return false;
  }
  if (!script || script.length === 0) return false;
  sc = script; idx = 0;
  return true;
}

async function go() {
  if (!selectedQuestId) return;
  document.getElementById('quest-log').textContent = 'Chargement...';
  const ok = await loadQuest(selectedQuestId);
  if (!ok) { document.getElementById('quest-log').textContent = 'Aucun contenu.'; return; }
  document.getElementById('quest-log').textContent = '';
  document.getElementById('quest-screen').style.display = 'none';
  document.getElementById('reader-container').style.display = 'block';
  document.getElementById('char-container').style.display = 'none';
  run();
}

async function goNextQuest() {
  const all = allQuests();
  let i = all.findIndex(q => String(q.id) === String(currentQuestId));
  while (++i < all.length) {
    const ok = await loadQuest(all[i].id);
    if (ok) { run(); return; }
  }
  stop();
}

function showChoices(choices) {
  const overlay = document.getElementById('choice-overlay');
  const box = document.getElementById('choice-box');
  [...box.querySelectorAll('.choice-btn')].forEach(b => b.remove());
  choices.forEach(choice => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    const text = typeof choice === 'string' ? choice : choice.text;
    const steps = (typeof choice === 'object' && choice.steps) ? choice.steps : [];
    btn.textContent = text;
    btn.onclick = () => {
      overlay.classList.remove('active');
      if (steps.length > 0) sc.splice(idx + 1, 0, ...steps);
      idx++; run();
    };
    box.appendChild(btn);
  });
  overlay.classList.add('active');
}

async function run() {
  if (idx >= sc.length) {
    audio.pause();
    const nq = nextQuest();
    const label = document.getElementById('end-next-label');
    const btnNext = document.getElementById('btn-next-quest');
    if (nq) { label.textContent = `Suivant : ${nq.name}`; btnNext.style.display = ''; }
    else { label.textContent = 'Fin du contenu disponible.'; btnNext.style.display = 'none'; }
    document.getElementById('end-overlay').classList.add('active');
    return;
  }
  const line = sc[idx];
  let autoSkip = true;

  if (line.stopBgm) audio.pause();
  else if (line.bgm && audio.src !== line.bgm) { audio.src = line.bgm; audio.play().catch(() => {}); }

  if (line.se) { seAudio.src = line.se; seAudio.play().catch(() => {}); }

  if (line.background) document.getElementById('bg-layer').style.backgroundImage = `url('${line.background}')`;

  if (line.hideChar) document.getElementById('char-container').style.display = 'none';

  if (line.showChar) await Compositor.update(line.showChar.url, line.showChar.face, line.showChar.comm);

  if (line.choices) { showChoices(line.choices); isProcessing = true; return; }

  if (line.talk) {
    document.getElementById('speaker').innerText = line.talk.speakerName;
    document.getElementById('text').innerText = line.talk.detail;
    if (line.figure) await Compositor.update(line.figure.url, line.figure.face, line.figure.comm);
    autoSkip = false;
  }

  if (autoSkip) { isProcessing = true; setTimeout(() => { idx++; run(); }, 20); }
  else { isProcessing = false; }
}

function handleClick(e) { if (e.clientX < window.innerWidth / 2) prev(); else next(); }
function next() { if (!isProcessing && idx < sc.length) { idx++; run(); } }
function prev() {
  if (isProcessing) return;
  // Revient à la réplique précédente (en sautant les étapes auto :
  // décors, musiques...) et restaure le décor en vigueur à ce moment-là
  let j = idx - 1;
  while (j >= 0 && !sc[j].talk) j--;
  if (j < 0) return;
  for (let k = j; k >= 0; k--) {
    if (sc[k].background) {
      document.getElementById('bg-layer').style.backgroundImage = `url('${sc[k].background}')`;
      break;
    }
  }
  idx = j; run();
}
function stop() {
  audio.pause();
  audio.src = '';
  document.getElementById('reader-container').style.display = 'none';
  document.getElementById('end-overlay').classList.remove('active');
  document.getElementById('options-overlay').classList.remove('active');
  document.getElementById('choice-overlay').classList.remove('active');
  document.getElementById('char-container').style.display = 'none';
  document.getElementById('bg-layer').style.backgroundImage = '';
  sc = []; idx = 0; isProcessing = false;
  showChapterScreen();
}

// Service worker (PWA) — uniquement en https ou localhost
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
