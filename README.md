# FGO Reader

Lecteur d'histoire **Fate/Grand Order** dans le navigateur, basé sur les données publiques d'[Atlas Academy](https://atlasacademy.io/).

L'appli est 100 % statique (`docs/`) : elle parle directement à l'API Atlas Academy, aucun serveur n'est nécessaire.

## Jouer

- **En ligne** : via GitHub Pages (Settings → Pages → branche `main`, dossier `/docs`).
- **Sur téléphone** : ouvrir l'URL GitHub Pages puis « Ajouter à l'écran d'accueil » — l'appli s'installe en plein écran (PWA, orientation paysage).
- **En local** : `npm install` puis `node server.js` → http://localhost:3000

## Structure

- `docs/` — l'application (HTML/JS/PWA), déployable telle quelle
- `server.js` — petit serveur statique pour le développement local
- `scan_final.js` / `scan_full.js` — anciens scripts Puppeteer de scan des positions de sprites (gardés pour référence ; l'appli utilise désormais l'API `svtScript` en direct)

Les sprites, décors, musiques et scripts restent hébergés par Atlas Academy et sont chargés à la volée.
