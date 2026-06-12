// Serveur local de développement : sert l'appli statique de docs/.
// Toute la logique (API Atlas Academy, parsing des scripts) tourne
// désormais dans le navigateur (docs/app.js) — c'est la même version
// que celle hébergée sur GitHub Pages.
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "docs")));

app.listen(PORT, () => {
  console.log(`FGO Reader : http://localhost:${PORT}`);
});
