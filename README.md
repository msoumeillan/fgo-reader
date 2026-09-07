# FGO Reader

Lecteur d'histoire **Fate/Grand Order** dans le navigateur : rejouer les scénarios du jeu — dialogues, sprites, décors, musiques, cinématiques — sans installer le jeu ni créer de compte.

**▶️ [Essayer en ligne](https://msoumeillan.github.io/fgo-reader/)** · JavaScript vanilla, aucune dépendance, aucun build

<!-- Dépose une capture d'écran ici : docs/screenshot.png
![Aperçu](docs/screenshot.png)
-->

## Fonctionnalités

- **Navigation complète** — tous les chapitres, quêtes et phases de la version NA, chargés à la demande
- **Moteur de rendu de scène** — sprites de personnages positionnés à l'échelle exacte du jeu, décors, expressions faciales, fondus d'entrée et de sortie
- **Dialogues fidèles** — boîte de dialogue FGO, choix embranchés, journal de lecture, mode lecture automatique
- **Audio** — musiques, effets sonores et volume maître
- **Séquences spéciales** — cinématiques vidéo, images de scénario (CG et cut-ins), appels vidéo avec effet visio
- **PWA installable** — plein écran paysage sur mobile via « Ajouter à l'écran d'accueil »

## Comment ça marche

L'appli est **100 % côté navigateur**. Elle interroge directement l'API publique d'[Atlas Academy](https://atlasacademy.io/), qui autorise le CORS — donc ni serveur, ni clé d'API, ni authentification.

**Parsing des scripts du jeu.** Les scénarios sont livrés dans un format de script propriétaire qu'il faut interpréter commande par commande : entrées et sorties de personnages, changements de décor, d'expression et de tenue, branchements de choix. Le texte lui-même demande un nettoyage spécifique — substitution du nom du protagoniste, variantes genrées, annotations ruby, balises de mise en forme.

**Composition des sprites.** C'est le morceau le plus délicat. Les visages des personnages sont empaquetés dans des planches d'images dont la géométrie varie selon le personnage, et il faut recalculer les coordonnées de découpe à partir des métadonnées `svtScript` : taille de visage, décalages, hauteur réelle de la planche, pagination des rangées. La scène est calée sur la référence 1024×576 du jeu, puis remise à l'échelle selon l'orientation de l'écran.

Le détail de l'algorithme et les cas particuliers sont documentés dans [`AGENTS.md`](AGENTS.md).

## Développement

```bash
npm install
node server.js     # http://localhost:3000
```

`server.js` sert simplement `docs/` en statique — toute la logique est dans le navigateur. Pas de build, pas de framework, pas d'étape de compilation : après une modification, il suffit de recharger la page (Ctrl+F5 pour vider le cache du service worker).

## Structure

| Chemin | Rôle |
|---|---|
| `docs/` | L'application, déployée telle quelle par GitHub Pages |
| `docs/app.js` | Cœur du projet : appels API, parsing des scripts, compositeur de scène |
| `docs/index.html` | Interface et styles |
| `docs/sw.js`, `manifest.webmanifest` | Service worker et manifeste PWA |
| `server.js` | Serveur statique pour le développement local |
| `public/`, `scan_*.js` | Ancienne version et scrapers Puppeteer — conservés pour référence |

## Crédits

Projet de fan non officiel, sans lien avec TYPE-MOON, Aniplex ou Delightworks. Les scripts, sprites, décors et musiques restent la propriété de leurs ayants droit et sont chargés à la volée depuis [Atlas Academy](https://atlasacademy.io/), qui rend ces données publiquement accessibles. Aucun asset n'est redistribué par ce dépôt.
