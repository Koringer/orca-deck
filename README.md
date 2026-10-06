# Orca Deck

Plugin Stream Deck (pensé pour le **Stream Deck Neo**) : une touche par worktree [Orca](https://www.onorca.dev), avec l'état de l'agent en direct.

| Geste | Effet |
|---|---|
| Appui court sur un worktree | Ouvre son terminal d'agent dans Orca (lance l'agent s'il n'y a rien) |
| Appui long (0,7 s) sur un worktree | **Remplace** le worktree : `worktree rm`, puis nouveau worktree dans le même repo + nouvel agent, sur la même touche |
| Appui sur `+` | Nouveau worktree + agent |
| Orca fermé | N'importe quelle touche lance Orca |

S'il y a des changements non commités, l'appui long ne supprime rien : la touche affiche *UNCOMMITTED CHANGES*. Un second appui long dans les 6 s force la suppression (`--force`).

**Bordure épaisse = état** (elle "respire" sauf en idle) :
🟡 working · 🔵 input (l'agent attend) · 🟢 done (respire tant que non lu) · 🔴 error · 🟣 review · ⚪ idle

**Infobar du Neo** :
- au repos : compteurs `ask / work / done / idle` + jauges de tokens (fenêtre 5 h et semaine) du compte Claude/Codex géré par Orca ;
- si un worktree attend : "*xxx* needs you" ;
- après appui sur une touche (6 s) : nom du worktree + statut · agent · durée · outil en cours / dernier message · commentaire · branche (défilant).

## Installation (n'importe quelle machine)

Il faut **l'app Stream Deck ≥ 7.6** (Mac ou Windows) et **Orca** installé.

1. Double-cliquer `dist/dev.orcadeck.streamDeckPlugin`.
2. Dans l'app Stream Deck, catégorie **Orca Deck** : glisser **Worktree** sur les 8 touches et **Orca Infobar** sur l'infobar.
3. (Optionnel) réglages dans l'inspecteur : agent (`claude` par défaut), repo pour `+`, durée d'appui long, chemin du CLI.

Le CLI `orca` est détecté automatiquement (PATH, `/Applications/Orca.app`, `%LOCALAPPDATA%\Programs\Orca`).
Pour une 2ᵉ page sur le Neo, mettre `Neo page = 2` sur ses touches : elles prennent les worktrees 9 à 16.

## Développement

```bash
npm install
npm run build      # bundle → dev.orcadeck.sdPlugin/bin/plugin.js
npm run link       # installe le dossier en mode dev dans l'app Stream Deck
npm run dev        # rebuild en continu (puis `npx streamdeck restart dev.orcadeck`)
npm test
npm run pack       # → dist/dev.orcadeck.streamDeckPlugin
```

Données : `orca worktree ps --json` (toutes les 1,5 s) et `orca account list --json` (rate limits, toutes les 60 s).
Actions : `orca terminal list|switch|create`, `orca worktree rm|create --agent … --activate`.
