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

function secondsToMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
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
      let imageBindings = {};   // code -> URL d'image (imageSet)
      let currentImage = null;  // code de l'image actuellement affichée
      let charPositions = {};   // code -> slot (0/1/2) ou coordonnées x,y

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

        // Timeline : attente explicite ou attente de fin d'un effet démarré
        // par une commande précédente.
        const timedWaitMatch = line.match(/^\[wt\s+([0-9]*\.?[0-9]+)\]/);
        if (timedWaitMatch) {
          step.waitMs = secondsToMs(timedWaitMatch[1]);
          stepBuffer.push(step);
          continue;
        }
        const effectWaitMatch = line.match(/^\[wait\s+([a-zA-Z]+)/);
        if (effectWaitMatch) {
          step.waitFor = effectWaitMatch[1];
          stepBuffer.push(step);
          continue;
        }

        // Effets écran : fondus, flashs, wipes et tremblements.
        const fadeMatch = line.match(/\[(fadein|fadeout)\s+(black|white)\s+([0-9]*\.?[0-9]+)/);
        if (fadeMatch) {
          step.screenFade = {
            direction: fadeMatch[1],
            color: fadeMatch[2],
            durationMs: secondsToMs(fadeMatch[3]),
          };
        }
        const flashMatch = line.match(/\[flashin\s+(once|loop)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})/);
        if (flashMatch) {
          step.flash = {
            mode: flashMatch[1],
            inMs: secondsToMs(flashMatch[2]),
            outMs: secondsToMs(flashMatch[3]),
            from: `#${flashMatch[4]}`,
            to: `#${flashMatch[5]}`,
          };
        }
        const flashOutMatch = line.match(/\[flashout\s+([0-9]*\.?[0-9]+)/);
        if (flashOutMatch) step.flashOutMs = secondsToMs(flashOutMatch[1]);

        const wipeMatch = line.match(/\[(wipein|wipeout)\s+([a-zA-Z]+)\s+([0-9]*\.?[0-9]+)/);
        if (wipeMatch) {
          step.wipe = {
            direction: wipeMatch[1],
            type: wipeMatch[2],
            durationMs: secondsToMs(wipeMatch[3]),
          };
        }
        const wipeFilterMatch = line.match(/\[wipeFilter\s+([a-zA-Z]+)\s+([0-9]*\.?[0-9]+)/);
        if (wipeFilterMatch) {
          step.wipeFilter = {
            type: wipeFilterMatch[1],
            durationMs: secondsToMs(wipeFilterMatch[2]),
          };
        }
        if (line.includes("[wipeOff]")) step.wipeOff = true;

        const shakeMatch = line.match(/\[shake\s+([0-9]*\.?[0-9]+)\s+(-?[0-9]*\.?[0-9]+)\s+(-?[0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)/);
        if (shakeMatch) {
          step.screenShake = {
            intervalMs: secondsToMs(shakeMatch[1]),
            x: Number(shakeMatch[2]),
            y: Number(shakeMatch[3]),
            durationMs: secondsToMs(shakeMatch[4]),
          };
        }
        if (line.includes("[shakeStop]")) step.screenShakeStop = true;

        // Caméra : translation sur la scène de référence 1024x576 et zoom.
        const cameraMoveMatch = line.match(/\[cameraMove\s+([0-9]*\.?[0-9]+)\s+(-?[0-9]*\.?[0-9]+),(-?[0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)/);
        if (cameraMoveMatch) {
          step.camera = {
            durationMs: secondsToMs(cameraMoveMatch[1]),
            x: Number(cameraMoveMatch[2]),
            y: Number(cameraMoveMatch[3]),
            scale: Number(cameraMoveMatch[4]),
          };
        }
        const cameraHomeMatch = line.match(/\[cameraHome\s+([0-9]*\.?[0-9]+)/);
        if (cameraHomeMatch) {
          step.camera = { durationMs: secondsToMs(cameraHomeMatch[1]), x: 0, y: 0, scale: 1 };
        }

        // 0) communicationChara / Loop : appel vidéo (sprite spécial bleu
        // 98003xxx + effet transparence/scanlines). Le dernier nombre = visage.
        const commMatch = line.match(/communicationChara(?:Loop)?\s+([0-9]+)((?:\s+\d+)*)\s*\]/);
        if (commMatch) {
          const charId = commMatch[1];
          const extra = commMatch[2].trim().split(/\s+/).filter(Boolean).map(Number);
          const face = extra.length ? extra[extra.length - 1] : 0;
          commActive = { url: `${ASSETS}/${REGION}/CharaFigure/${charId}/${charId}_merged.png`, face };
          step.showChar = { code: "communication", url: commActive.url, face: commActive.face, comm: true };
          step.charPosition = "1";
          lastShownCode = null;
          stepBuffer.push(step);
          continue;
        }
        // communicationCharaFace N : change l'expression dans l'appel
        const commFaceMatch = line.match(/communicationCharaFace\s+([0-9]+)/);
        if (commFaceMatch) {
          if (commActive) {
            commActive.face = parseInt(commFaceMatch[1], 10);
            step.showChar = { code: "communication", url: commActive.url, face: commActive.face, comm: true };
            step.charPosition = "1";
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

        // imageSet / verticalImageSet / horizontalImageSet : lie un code à une
        // image (cut-in, CG) affichée ensuite via charaFadein/charaMove
        const imageSetMatch = line.match(/(?:imageSet|verticalImageSet|horizontalImageSet)\s+([a-zA-Z0-9]+)\s+([a-zA-Z0-9_]+)/);
        if (imageSetMatch) {
          imageBindings[imageSetMatch[1]] = `${ASSETS}/${REGION}/Image/${imageSetMatch[2]}/${imageSetMatch[2]}.png`;
          continue;
        }
        // messageOff / messageOn : cache / réaffiche la boîte de dialogue
        // (souvent pendant l'affichage plein écran d'une image)
        if (line.includes("messageOff")) { step.textBox = 'off'; stepBuffer.push(step); continue; }
        if (line.includes("messageOn")) { step.textBox = 'on'; stepBuffer.push(step); continue; }

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
          if (!(code in charPositions)) charPositions[code] = "1";
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
        const faceMatch = line.match(/charaFace(Fade)?\s+([a-zA-Z0-9]+)\s+([0-9]+)(?:\s+([0-9]*\.?[0-9]+))?/);
        if (faceMatch) {
          const code = faceMatch[2];
          const newFace = parseInt(faceMatch[3], 10);
          if (speakerState[code] && Number.isFinite(newFace)) {
            speakerState[code].currentFace = newFace;
            if (visibleChars.has(code)) {
              step.showChar = {
                code,
                url: speakerState[code].url,
                face: speakerState[code].currentFace,
              };
              step.charPosition = charPositions[code] || "1";
              if (faceMatch[1]) step.charCrossFadeMs = secondsToMs(faceMatch[4] || 0.2);
            }
          }
          if (Object.keys(step).length > 0) stepBuffer.push(step);
          continue;
        }

        // 2b) charaFadeout : personnage (ou image) qui disparaît
        const fadeoutMatch = line.match(/charaFadeout\s+([a-zA-Z0-9]+)(?:\s+([0-9]*\.?[0-9]+))?/);
        if (fadeoutMatch) {
          const outCode = fadeoutMatch[1];
          const durationMs = secondsToMs(fadeoutMatch[2] || 0);
          visibleChars.delete(outCode);
          if (visibleChars.size === 0) {
            step.hideChar = true;
            step.charCode = outCode;
            step.charFadeOutMs = durationMs;
            lastShownCode = null;
          }
          if (outCode === currentImage) {
            step.hideImage = true;
            step.imageFadeOutMs = durationMs;
            currentImage = null;
          }
        }

        // 2c) charaFadein / charaPut : personnage qui devient visible.
        // On l'affiche dès son entrée en scène (il reste affiché si un autre
        // perso parle hors écran, ex. Romani en communication).
        // NB : [charaTalk X] est un simple effet de focus, PAS une apparition
        const fadeinMatch = line.match(/chara(?:Fadein|Put(?:FSR)?)\s+([a-zA-Z0-9]+)(?:\s+([0-9]*\.?[0-9]+))?(?:\s+(-?[0-9]+(?:,-?[0-9]+)?))?/);
        if (fadeinMatch) {
          const inCode = fadeinMatch[1];
          if (speakerState[inCode]) {
            visibleChars.add(inCode);
            step.showChar = {
              code: inCode,
              url: speakerState[inCode].url,
              face: speakerState[inCode].currentFace,
            };
            step.charFadeInMs = secondsToMs(fadeinMatch[2] || 0);
            if (fadeinMatch[3] !== undefined) charPositions[inCode] = fadeinMatch[3];
            step.charPosition = charPositions[inCode] || "1";
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
              code: inCode,
              url: speakerState[inCode].url,
              face: speakerState[inCode].currentFace,
            };
            step.charPosition = charPositions[inCode] || "1";
            lastShownCode = inCode;
          }
        }

        // Image (imageSet) révélée, déplacée ou en cut-in → on l'affiche (une à
        // la fois). [charaTalk on/off] est un réglage global (pas un code d'image).
        const imgRevealMatch = line.match(/chara(?:Fadein|Move|Talk|Cutin|Put(?:FSR)?)\s+([a-zA-Z0-9]+)/);
        if (imgRevealMatch && imageBindings[imgRevealMatch[1]]) {
          step.showImage = { url: imageBindings[imgRevealMatch[1]] };
          if (fadeinMatch?.[1] === imgRevealMatch[1]) step.imageFadeInMs = secondsToMs(fadeinMatch[2] || 0);
          currentImage = imgRevealMatch[1];
        }

        const charMoveMatch = line.match(/\[charaMove(?:Return)?\s+([a-zA-Z0-9]+)\s+(-?[0-9]+(?:,-?[0-9]+)?)\s+([0-9]*\.?[0-9]+)/);
        if (charMoveMatch) {
          charPositions[charMoveMatch[1]] = charMoveMatch[2];
          step.charMove = {
            code: charMoveMatch[1],
            position: charMoveMatch[2],
            durationMs: secondsToMs(charMoveMatch[3]),
          };
        }
        const charShakeMatch = line.match(/\[charaShake\s+([a-zA-Z0-9]+)\s+([0-9]*\.?[0-9]+)\s+(-?[0-9]*\.?[0-9]+)\s+(-?[0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)/);
        if (charShakeMatch) {
          step.charShake = {
            code: charShakeMatch[1],
            intervalMs: secondsToMs(charShakeMatch[2]),
            x: Number(charShakeMatch[3]),
            y: Number(charShakeMatch[4]),
            durationMs: secondsToMs(charShakeMatch[5]),
          };
        }

        // 3) background: [scene 10310] / [scene 10310 2.0].
        // Le second nombre est la durée de transition, en secondes.
        const sceneMatch = line.match(/scene(?:,|\s)+([0-9]+)(?:(?:,|\s)+([0-9]*\.?[0-9]+))?/);
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
          if (sceneMatch?.[2] !== undefined) {
            step.frameDurationMs = Number(sceneMatch[2]) * 1000;
          }
          lastBackground = foundBg;
          // Un changement de décor réinitialise la scène : les persos
          // doivent être ré-introduits par charaFadein dans le script
          visibleChars.clear();
          lastShownCode = null;
          commActive = null;
          currentImage = null;
          step.hideChar = true;
          step.hideImage = true;
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

        // 6) Dialogue text. Une réplique peut commencer par une balise de mise
        // en forme ([couleur], [line], [#ruby]...), donc on ne peut pas se fier
        // à « commence par [ » pour distinguer commande et dialogue. On tente
        // de parser toute ligne dès qu'un interlocuteur est défini : les lignes
        // de commande pure se nettoient en chaîne vide et sont ignorées juste
        // en dessous (garde length > 0).
        if (currentSpeakerName) {
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
                code,
                url: speakerState[code].url,
                face: speakerState[code].currentFace,
              };
              step.charPosition = charPositions[code] || "1";
              lastShownCode = code;
            }
            // Sinon, si un appel vidéo est en cours, on affiche le perso appelé
            // (effet visio) — typiquement Romani en communication
            else if (commActive) {
              step.figure = { code: "communication", url: commActive.url, face: commActive.face, comm: true };
              step.charPosition = "1";
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

  // Passe finale : un « frame » visuel (image CG ou changement de décor) qui
  // n'est suivi d'AUCUN dialogue avant le frame suivant serait auto-sauté — le
  // lecteur ne s'arrête que sur les répliques, donc une rafale de décors/CG
  // cinématiques file jusqu'au dernier. On en fait un point d'arrêt (holdFrame)
  // pour laisser le temps de le voir.
  // - décor : « porté » si une réplique arrive avant le prochain décor ;
  // - image : « portée » si une réplique arrive avant qu'elle soit cachée /
  //   remplacée par un perso / un décor (les couches d'image consécutives
  //   forment un composite et ne coupent pas la recherche).
  for (let i = 0; i < combinedScript.length; i++) {
    const cur = combinedScript[i];
    if (!cur.showImage && !cur.background) continue;
    let carried = false;
    for (let j = i + 1; j < combinedScript.length; j++) {
      const s = combinedScript[j];
      if (s.talk || s.choices) { carried = true; break; }
      if (s.background) break;
      if (cur.showImage && (s.hideImage || s.showChar)) break;
    }
    if (!carried) cur.holdFrame = true;
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

const effectUntil = {};
let screenShakeAnimation = null;
let charShakeAnimation = null;
let flashAnimation = null;
let currentDisplayedCode = null;
let charAnimationToken = 0;
let imageAnimationToken = 0;
let wipeAnimationToken = 0;
const opacityAnimationTokens = new WeakMap();

function markEffect(name, durationMs, indefinite = false) {
  effectUntil[name.toLowerCase()] = indefinite ? Infinity : performance.now() + Math.max(0, durationMs);
}

function stopEffect(name) {
  effectUntil[name.toLowerCase()] = 0;
}

function remainingEffect(name) {
  const end = effectUntil[(name || "").toLowerCase()] || 0;
  return end === Infinity ? 0 : Math.max(0, end - performance.now());
}

function cancelAnimation(animation) {
  if (animation) animation.cancel();
}

function referenceScale() {
  return window.innerHeight / 576;
}

function animateOpacity(element, from, to, durationMs, hideAfter = false) {
  element.getAnimations().forEach(animation => animation.cancel());
  const token = (opacityAnimationTokens.get(element) || 0) + 1;
  opacityAnimationTokens.set(element, token);
  element.style.display = 'block';
  element.style.opacity = String(from);
  const animation = element.animate(
    [{ opacity: from }, { opacity: to }],
    { duration: durationMs, easing: 'linear', fill: 'forwards' }
  );
  const finish = () => {
    if (opacityAnimationTokens.get(element) !== token) return;
    element.style.opacity = String(to);
    if (hideAfter) element.style.display = 'none';
    animation.cancel();
  };
  animation.finished.then(finish).catch(() => {});
  setTimeout(finish, durationMs + 20);
  return animation;
}

function playFade(effect) {
  const layer = document.getElementById('fade-layer');
  layer.style.background = effect.color;
  const fadingIn = effect.direction === 'fadein';
  animateOpacity(layer, fadingIn ? 1 : 0, fadingIn ? 0 : 1, effect.durationMs, fadingIn);
  markEffect('fade', effect.durationMs);
}

function playFlash(effect) {
  const layer = document.getElementById('flash-layer');
  cancelAnimation(flashAnimation);
  layer.style.display = 'block';
  const durationMs = Math.max(1, effect.inMs + effect.outMs);
  flashAnimation = layer.animate(
    [
      { opacity: 0, backgroundColor: effect.to },
      { opacity: 1, backgroundColor: effect.from, offset: effect.inMs / durationMs },
      { opacity: 0, backgroundColor: effect.to },
    ],
    {
      duration: durationMs,
      iterations: effect.mode === 'loop' ? Infinity : 1,
      easing: 'linear',
      fill: 'forwards',
    }
  );
  if (effect.mode === 'once') {
    const currentAnimation = flashAnimation;
    const finish = () => {
      if (flashAnimation !== currentAnimation) return;
      layer.style.display = 'none';
      currentAnimation.cancel();
      flashAnimation = null;
    };
    currentAnimation.finished.then(finish).catch(() => {});
    setTimeout(finish, durationMs + 20);
    markEffect('flash', durationMs);
  } else {
    markEffect('flash', 0, true);
  }
}

function stopFlash(durationMs) {
  cancelAnimation(flashAnimation);
  flashAnimation = null;
  const layer = document.getElementById('flash-layer');
  animateOpacity(layer, Number(getComputedStyle(layer).opacity) || 1, 0, durationMs, true);
  markEffect('flash', durationMs);
}

function wipeClip(type, covered) {
  const full = 'inset(0 0 0 0)';
  const emptyByType = {
    leftToRight: 'inset(0 100% 0 0)',
    rightToLeft: 'inset(0 0 0 100%)',
    upToDown: 'inset(0 0 100% 0)',
    downToUp: 'inset(100% 0 0 0)',
    rectangleStripLeftToRight: 'inset(0 100% 0 0)',
    rectangleStripRightToLeft: 'inset(0 0 0 100%)',
    circleIn: 'circle(0% at 50% 50%)',
  };
  return covered ? full : (emptyByType[type] || 'inset(0 100% 0 0)');
}

function playWipe(effect) {
  const layer = document.getElementById('wipe-layer');
  const token = ++wipeAnimationToken;
  layer.getAnimations().forEach(animation => animation.cancel());
  layer.style.display = 'block';
  layer.style.background = '#000';
  layer.style.opacity = '1';
  const wipingIn = effect.direction === 'wipein';
  const finalClip = wipeClip(effect.type, !wipingIn);
  const animation = layer.animate(
    [
      { clipPath: wipeClip(effect.type, wipingIn) },
      { clipPath: wipeClip(effect.type, !wipingIn) },
    ],
    { duration: effect.durationMs, easing: 'linear', fill: 'forwards' }
  );
  const finish = () => {
    if (wipeAnimationToken !== token) return;
    layer.style.clipPath = finalClip;
    if (wipingIn) layer.style.display = 'none';
    animation.cancel();
  };
  animation.finished.then(finish).catch(() => {});
  setTimeout(finish, effect.durationMs + 20);
  markEffect('wipe', effect.durationMs);
}

function playWipeFilter(effect) {
  const layer = document.getElementById('wipe-layer');
  wipeAnimationToken++;
  layer.getAnimations().forEach(animation => animation.cancel());
  layer.style.display = 'block';
  layer.style.clipPath = 'none';
  layer.style.background = effect.type === 'circleIn'
    ? 'radial-gradient(circle at center, transparent 35%, rgba(0,0,0,0.96) 72%)'
    : 'rgba(0,0,0,0.75)';
  animateOpacity(layer, 0, 1, effect.durationMs);
  markEffect('wipe', effect.durationMs);
}

function stopWipe() {
  wipeAnimationToken++;
  const layer = document.getElementById('wipe-layer');
  layer.getAnimations().forEach(animation => animation.cancel());
  layer.style.display = 'none';
  layer.style.clipPath = '';
  layer.style.background = '#000';
  stopEffect('wipe');
}

function shakeElement(element, effect, currentAnimation) {
  cancelAnimation(currentAnimation);
  const scale = referenceScale();
  const x = effect.x * scale;
  const y = effect.y * scale;
  const cycleMs = Math.max(20, effect.intervalMs * 2);
  return element.animate(
    [
      { transform: `translate(${-x}px, ${-y}px)` },
      { transform: `translate(${x}px, ${y}px)` },
      { transform: `translate(${-x}px, ${y}px)` },
      { transform: `translate(${x}px, ${-y}px)` },
    ],
    {
      duration: cycleMs,
      iterations: effect.durationMs > 0 ? Math.max(1, Math.ceil(effect.durationMs / cycleMs)) : Infinity,
      easing: 'steps(1)',
    }
  );
}

function playScreenShake(effect) {
  screenShakeAnimation = shakeElement(document.getElementById('visual-stage'), effect, screenShakeAnimation);
  markEffect('shake', effect.durationMs, effect.durationMs === 0);
}

function stopScreenShake() {
  cancelAnimation(screenShakeAnimation);
  screenShakeAnimation = null;
  stopEffect('shake');
}

function playCharShake(effect) {
  if (effect.code !== currentDisplayedCode) return;
  charShakeAnimation = shakeElement(document.getElementById('char-motion'), effect, charShakeAnimation);
  markEffect('charashake', effect.durationMs, effect.durationMs === 0);
}

function moveCamera(camera) {
  const layer = document.getElementById('camera-layer');
  const scale = referenceScale();
  layer.style.transition = `transform ${camera.durationMs}ms ease-in-out`;
  layer.style.transform = `translate(${camera.x * scale}px, ${camera.y * scale}px) scale(${camera.scale})`;
  markEffect('camera', camera.durationMs);
}

function charPosition(position) {
  if (String(position).includes(',')) {
    const [x, y] = String(position).split(',').map(Number);
    return { x: x * referenceScale(), y: y * referenceScale() };
  }
  const slot = Number(position);
  return { x: ((Number.isFinite(slot) ? slot : 1) - 1) * 220 * referenceScale(), y: 0 };
}

function moveCharacter(position, durationMs) {
  const container = document.getElementById('char-container');
  const target = charPosition(position);
  container.style.transition = `transform ${durationMs}ms ease-in-out, opacity ${durationMs}ms linear`;
  container.style.setProperty('--char-x', `${target.x}px`);
  container.style.setProperty('--char-y', `${target.y}px`);
  markEffect('charamove', durationMs);
}

function resetVisualEffects() {
  stopScreenShake();
  cancelAnimation(charShakeAnimation);
  charShakeAnimation = null;
  cancelAnimation(flashAnimation);
  flashAnimation = null;
  Object.keys(effectUntil).forEach(key => { effectUntil[key] = 0; });

  const camera = document.getElementById('camera-layer');
  camera.style.transition = 'none';
  camera.style.transform = '';
  const char = document.getElementById('char-container');
  char.style.transition = 'none';
  char.style.opacity = '1';
  char.style.setProperty('--char-x', '0px');
  char.style.setProperty('--char-y', '0px');
  currentDisplayedCode = null;
  charAnimationToken++;
  imageAnimationToken++;
  wipeAnimationToken++;

  for (const id of ['wipe-layer', 'fade-layer', 'flash-layer']) {
    const layer = document.getElementById(id);
    layer.getAnimations().forEach(animation => animation.cancel());
    layer.style.display = 'none';
    layer.style.opacity = '0';
  }
}

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
  // reset des couches visuelles entre deux quêtes
  resetVisualEffects();
  document.getElementById('cut-image').style.display = 'none';
  document.getElementById('text-box').classList.remove('msg-hidden');
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

  if (line.background) {
    document.getElementById('bg-layer').style.backgroundImage = `url('${line.background}')`;
    if (line.frameDurationMs !== undefined) markEffect('scene', line.frameDurationMs);
  }

  if (line.screenFade) playFade(line.screenFade);
  if (line.flash) playFlash(line.flash);
  if (line.flashOutMs !== undefined) stopFlash(line.flashOutMs);
  if (line.wipe) playWipe(line.wipe);
  if (line.wipeFilter) playWipeFilter(line.wipeFilter);
  if (line.wipeOff) stopWipe();
  if (line.screenShake) playScreenShake(line.screenShake);
  if (line.screenShakeStop) stopScreenShake();
  if (line.camera) moveCamera(line.camera);

  if (line.hideChar) {
    const char = document.getElementById('char-container');
    const token = ++charAnimationToken;
    if (line.charFadeOutMs > 0) {
      const hiddenCode = currentDisplayedCode;
      animateOpacity(char, Number(getComputedStyle(char).opacity) || 1, 0, line.charFadeOutMs);
      markEffect('charafade', line.charFadeOutMs);
      setTimeout(() => {
        if (charAnimationToken === token && currentDisplayedCode === hiddenCode) {
          char.style.display = 'none';
          char.style.opacity = '1';
          currentDisplayedCode = null;
        }
      }, line.charFadeOutMs);
    } else {
      char.style.display = 'none';
      currentDisplayedCode = null;
    }
  }

  if (line.hideImage) {
    const image = document.getElementById('cut-image');
    const token = ++imageAnimationToken;
    if (line.imageFadeOutMs > 0) {
      animateOpacity(image, Number(getComputedStyle(image).opacity) || 1, 0, line.imageFadeOutMs);
      markEffect('charafade', line.imageFadeOutMs);
      setTimeout(() => {
        if (imageAnimationToken === token) {
          image.style.display = 'none';
          image.style.opacity = '1';
        }
      }, line.imageFadeOutMs);
    } else {
      image.style.display = 'none';
    }
  }

  if (line.showChar) {
    charAnimationToken++;
    document.getElementById('cut-image').style.display = 'none';
    const char = document.getElementById('char-container');
    if (line.charPosition !== undefined) moveCharacter(line.charPosition, 0);
    if (line.charFadeInMs > 0 || line.charCrossFadeMs > 0) char.style.opacity = '0';
    await Compositor.update(line.showChar.url, line.showChar.face, line.showChar.comm);
    currentDisplayedCode = line.showChar.code || currentDisplayedCode;
    const fadeMs = line.charFadeInMs || line.charCrossFadeMs || 0;
    if (fadeMs > 0) {
      animateOpacity(char, 0, 1, fadeMs);
      markEffect('charafade', fadeMs);
    } else {
      char.style.opacity = '1';
    }
  }

  // Image (cut-in / CG) : on cache le perso pendant qu'on l'affiche (v1 : une à la fois)
  if (line.showImage) {
    imageAnimationToken++;
    document.getElementById('char-container').style.display = 'none';
    currentDisplayedCode = null;
    const ci = document.getElementById('cut-image');
    ci.style.backgroundImage = `url("${line.showImage.url}")`;
    ci.style.display = 'block';
    if (line.imageFadeInMs > 0) {
      animateOpacity(ci, 0, 1, line.imageFadeInMs);
      markEffect('charafade', line.imageFadeInMs);
    } else {
      ci.style.opacity = '1';
    }
  }

  if (line.charMove && line.charMove.code === currentDisplayedCode) {
    moveCharacter(line.charMove.position, line.charMove.durationMs);
  }
  if (line.charShake) playCharShake(line.charShake);

  if (line.textBox === 'off') document.getElementById('text-box').classList.add('msg-hidden');
  else if (line.textBox === 'on') document.getElementById('text-box').classList.remove('msg-hidden');

  if (line.choices) { showChoices(line.choices); isProcessing = true; return; }

  if (line.talk) {
    document.getElementById('text-box').classList.remove('msg-hidden');
    document.getElementById('speaker').innerText = line.talk.speakerName;
    document.getElementById('text').innerText = line.talk.detail;
    if (line.figure) {
      document.getElementById('cut-image').style.display = 'none';
      if (line.charPosition !== undefined) moveCharacter(line.charPosition, 0);
      await Compositor.update(line.figure.url, line.figure.face, line.figure.comm);
      currentDisplayedCode = line.figure.code || currentDisplayedCode;
    }
    autoSkip = false;
  }

  if (autoSkip) {
    let dwell = 20;
    if (line.waitMs !== undefined) dwell = line.waitMs;
    else if (line.waitFor) dwell = remainingEffect(line.waitFor);
    else if (line.holdFrame) dwell = line.frameDurationMs ?? (line.showImage ? 1200 : 650);

    // Les commandes automatiques respectent la timeline, mais un clic peut
    // toujours passer immédiatement à l'étape suivante.
    isProcessing = false;
    const myIdx = idx;
    setTimeout(() => { if (idx === myIdx && idx < sc.length) { idx++; run(); } }, dwell);
  }
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
  resetVisualEffects();
  document.getElementById('reader-container').style.display = 'none';
  document.getElementById('end-overlay').classList.remove('active');
  document.getElementById('options-overlay').classList.remove('active');
  document.getElementById('choice-overlay').classList.remove('active');
  document.getElementById('char-container').style.display = 'none';
  document.getElementById('cut-image').style.display = 'none';
  document.getElementById('text-box').classList.remove('msg-hidden');
  document.getElementById('bg-layer').style.backgroundImage = '';
  sc = []; idx = 0; isProcessing = false;
  showChapterScreen();
}

// Service worker (PWA) — uniquement en https ou localhost
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
