# Speaking Status

Indique quel joueur parle au micro dans Foundry VTT : son nom dans la liste des joueurs et le jeton de son personnage s'entourent de sa couleur.

Reprise du module [speaking-status](https://github.com/xaukael/speaking-status) de **Xaukael** (licence MIT), qui n'est plus maintenu. Cette version est réparée et suivie pour Foundry v13 / v14.

## Installation

Dans Foundry : **Modules complémentaires → Installer un module**, puis coller dans « URL du manifeste » :

```
https://github.com/magisterphamtom/speaking-status/releases/latest/download/module.json
```

## Fonctionnement

- Chaque joueur mesure son propre micro dans son navigateur : pas besoin d'activer l'audio/vidéo de Foundry (fonctionne aussi avec Discord à côté).
- Jeton entouré : celui du **personnage assigné** au joueur (Configuration du joueur), ou à défaut les jetons dont il est propriétaire.
- Réglage **Seuil de parole** (par joueur) avec un vumètre : parler et placer le trait rouge juste sous le niveau de la voix.

## Activer le micro

Au chargement de la partie, si le micro n'est pas encore autorisé, un panneau s'affiche en haut de l'écran : cliquer sur **Activer le micro**, puis **Autoriser** dans la fenêtre du navigateur. Les fois suivantes, le micro démarre tout seul.

## Si ça ne marche pas pour un joueur

Le joueur concerné lance cette macro sur son poste :

```js
game.modules.get("speaking-status").api.diagnostic()
```

Causes courantes :
- Foundry ouvert en `http://` (non sécurisé) : le navigateur bloque le micro des joueurs distants. Il faut une adresse en `https://`.
- Aucun personnage assigné et aucun jeton possédé sur la scène.
- Seuil trop haut pour son micro.

## Pour les développeurs

- Hook `changeSpeakingStatus` (`user`, `speaking`) appelé sur chaque client.
- Évènement `obs-speaking-update` sur `window` (`detail: { userId, speaking }`).
- API : `game.modules.get("speaking-status").api` → `diagnostic`, `startMicrophoneMonitor`, `stopMicrophoneMonitor`, `cleanSpeakingMarkers`.

---

*English:* shows who is talking in Foundry VTT (player list and token highlighted in the player's colour). Maintained fork of Xaukael's module for Foundry v13/v14, no socketlib required.
