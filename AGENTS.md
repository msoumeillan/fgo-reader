# FGO Reader — contexte projet

Lecteur d'histoire **Fate/Grand Order** dans le navigateur, basé sur les données
publiques d'[Atlas Academy](https://atlasacademy.io/). Région utilisée : **NA**
(anglais). Aucune clé d'API, aucune authentification : l'API Atlas autorise le
CORS (`Access-Control-Allow-Origin: *`), donc tout se fait côté navigateur.

## Lancer / développer

- **Local** : `node server.js` → http://localhost:3000 (ou variable `PORT`).
  `server.js` est juste un serveur **statique** qui sert `docs/` — aucune logique
  métier dedans. Dépendance : `express` (`npm install` au besoin).
- **Pas de build, pas de framework, pas de tests.** JS vanilla.
- Après une modif de `docs/`, il suffit de recharger la page (Ctrl+F5 pour vider
  le cache du service worker).

## Architecture (IMPORTANT)

L'appli est **100 % statique** et vit dans **`docs/`** (dossier servi tel quel
par GitHub Pages). Toute la logique est dans le navigateur.

- `docs/index.html` — UI (sélection chapitre → quête → lecteur), CSS responsive
  + tactile, métadonnées PWA.
- `docs/app.js` — **tout le cœur** : appels API Atlas, parsing des scripts du
  jeu, et le `Compositor` qui place les sprites. C'est ici qu'on travaille.
- `docs/manifest.webmanifest`, `docs/sw.js`, `docs/icon-*.png` — PWA
  (installation sur téléphone, plein écran paysage). Icônes régénérables via
  `node gen_icons.js` (génère des PNG sans dépendance).

⚠️ **`public/` est l'ANCIENNE version** (front + serveur Express qui faisait le
parsing côté Node). Obsolète, gardée pour référence seulement. Ne pas y toucher :
le code vivant est dans `docs/`.

`scan_final.js` / `scan_full.js` — anciens scrapers Puppeteer des positions de
sprites. Plus utilisés (on lit l'API `svtScript` en direct). Référence
uniquement ; idem pour `script_positions*.json`, `scanned_history*.txt`.

## Sources de données (API Atlas Academy)

- `https://api.atlasacademy.io/export/NA/basic_war.json` — liste légère des
  chapitres (« wars »).
- `https://api.atlasacademy.io/nice/NA/war/{id}` — détail d'un chapitre (spots,
  quêtes, bannière). Chargé à la demande quand on ouvre un chapitre.
- `https://api.atlasacademy.io/nice/NA/quest/{id}` — donne les URLs des scripts.
- Scripts bruts, sprites, décors, audio : `https://static.atlasacademy.io/NA/...`

## Rendu des sprites (le point délicat)

Position/géométrie des visages via
`https://api.atlasacademy.io/raw/NA/svtScript?charaId={figureId}`.
**Crucial** : les PNJ comme **Romani** (figures `98003xxx`) n'existent PAS sur
`nice/NA/svt/` (404) ; `raw/svtScript` est le seul endpoint qui les couvre.
`extendData.faceSize` / `faceSizeRect` donne la taille du visage (défaut 256).

L'algorithme de découpe des visages dans la planche `*_merged.png` est porté du
viewer officiel `atlasacademy/apps` (`packages/db/src/Component/Scene.tsx`) :
- Scène de référence du jeu = **1024×576**, calée sur la hauteur d'écran.
- Le corps se place avec `offsetX` / `offsetY` de svtScript.
- Cas **standard** (visage 256px, PNG de base haut de 1024) : la 1ʳᵉ rangée de
  visages commence à y=768 dans la planche.
- Cas **non standard** : `y = figureHeight + 1024*page + rangée*h` ; `figureHeight`
  = hauteur réelle du PNG, lue via `Image.naturalHeight`.
- En portrait, le `Compositor` réduit l'échelle pour que le buste tienne à
  l'écran ; en paysage c'est l'échelle exacte du jeu.

## Parsing des scripts — pièges déjà résolus (ne pas régresser)

- **Visibilité des persos** : un sprite ne s'affiche QUE si le perso est entré en
  scène (`charaFadein` / `charaPut` / `charaCrossFade`) et pas encore sorti
  (`charaFadeout`). Un perso qui parle hors écran (Romani en
  `[communicationChara]`) ne doit RIEN afficher. `[charaTalk X]` est un effet de
  focus, **pas** une apparition.
- Un changement de décor (`[scene]`) vide la scène (les persos doivent être
  ré-introduits).
- `[charaChange]` change le sprite d'un perso (tenue/forme) en gardant son nom ;
  `[charaFaceFade]` est un changement d'expression (comme `[charaFace]`).
- Effets sonores : dossier selon le préfixe du fichier — `ba`→Battle,
  `ar`→ResidentSE, `21`→SE_21, sinon SE.
- Nettoyage texte : `[%1]`→Fujimaru, texte genré `[&masc:fém]` (garder le
  masculin), ruby `[#texte:lecture]`, `[servantName id:caché:vrai]`, `[r]/[sr]`
  → espace. Voir `cleanDialogueText()`.

## Déploiement

GitHub Pages : remote `origin` = `github.com/msoumeillan/fgo-reader`, branche
`main`, **dossier `/docs`** (Settings → Pages). URL :
`https://msoumeillan.github.io/fgo-reader/`. Sur mobile : ouvrir l'URL puis
« Ajouter à l'écran d'accueil » pour l'installer en PWA.
