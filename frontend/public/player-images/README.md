# Local player images

Draft11 does not download player photos and does not use the `player_url` column. That column is a SoFIFA profile page, not an image.

To show a photo on a card:

1. Confirm you have the right to display that image in Draft11.
2. Save the file as `frontend/public/player-images/<sofifa_id>.png` (`.jpg`, `.jpeg`, and `.webp` are also accepted). The id is the player's `sofifa_id`, for example `158023.png`.
3. Add that same id to the `approved` array in `data/player-image-approvals.json`. A file that is not listed there is stored as a reference only and is not shown.
4. Run `npm run import:players` from the repository root, then `npm run seed` if MongoDB should receive the updated cards.
5. Set `DRAFT11_PLAYER_PHOTOS=1` on the backend and `VITE_PLAYER_PHOTOS=1` on the frontend. Both stay off until you turn them on.

The card keeps its size and shows the silhouette when the file is missing, not approved, disabled, or fails to load. Do not put remote URLs in the catalog.

Elite portraits collected from Wikimedia Commons or Openverse use `fut23_<name>.jpg` (or `.png` / `.webp`). Discovery does not approve them. A fut23 photo is still hidden unless the file validates, `data/player-image-manifest.json` marks it approved, personality and licence review is complete, the id is in `data/player-image-approvals.json`, and both photo environment flags are on. A Creative Commons licence does not clear personality or publicity rights.
