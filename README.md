# spectra-terrain — Langmuir

Page dédiée à l'album *Langmuir* : visualisation 3D en temps réel du spectre
audio de chaque morceau. La FFT (Web Audio API, `AnalyserNode`) est écrite en
continu dans une texture qui défile, et un vertex shader déplace une grille
en fonction de cette texture — un "terrain-spectrogramme" qui avance tout
seul, sans aucune étape hors ligne.

## Démarrer

```sh
npm install
npm run dev
```

La pochette (`a1.JPG`) sert de fond, le logo et les titres de morceaux sont
composés à partir de l'alphabet pointillé dessiné à la main (`b3typo.jpg`,
lettres découpées automatiquement dans `public/album/glyphs/`). Cliquer un
morceau dans la rangée du haut le joue et met à jour l'URL (`#slug`) — un
lien direct vers `#alpha`, `#cage`, etc. relance ce morceau à l'ouverture.
Comme aucun navigateur n'autorise le son avant un geste de l'utilisateur, un
morceau ouvert par lien direct est préchargé en silence — la page reste sur sa
pochette, seul le bouton du morceau s'allume — et démarre au premier clic ou à
la première touche, sans rien demander.

L'album s'enchaîne tout seul : à la fin d'un morceau le suivant démarre, et
après le dernier on repart au premier. Seul « stop » revient à la pochette.
L'enchaînement est sans blanc — le morceau suivant est téléchargé, décodé et
**programmé sur l'horloge audio** vingt secondes avant la fin du précédent,
pour démarrer à l'échantillon près où celui-ci s'arrête, au lieu d'être
chargé une fois le silence déjà installé.

Le panneau ⚙ propose aussi des **réglages automatiques** : largeur, hauteur et
courbe dérivent chacune vers des valeurs tirées au hasard, à leur propre
rythme, avec un curseur de vitesse commun. La page s'ouvre là-dessus, vitesse
au minimum et texture « dessiné ».

## Structure

- `src/main.js` — scène Three.js, caméra, boucle de rendu, sélection de morceau.
- `src/audio.js` — chargement d'un fichier ou d'une URL + analyse FFT en direct.
- `src/terrain.js` — grille + texture-spectrogramme qui défile + matériau shader.
- `src/album.js` — liste des morceaux et composition des titres en glyphes.
- `src/glyph-sizes.json` — dimensions/descente de chaque glyphe extrait.
- `src/shaders/terrain.vert.glsl` — déplacement des sommets selon la texture.
- `src/shaders/terrain.frag.glsl` — couleur selon la hauteur.
- `public/album/` — pochette, logo, glyphes et pistes mp3 servis tels quels.

## Prochaines étapes possibles

- Remplacer `OrbitControls` par une caméra qui avance seule dans le terrain.
- Ajouter du bloom / post-processing pour l'ambiance.
- Mapper plusieurs bandes de fréquences vers plusieurs canaux de couleur.
