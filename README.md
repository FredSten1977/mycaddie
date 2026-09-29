# My Caddie

Personlig golfapp: TrackMan-data synkes automatisk, klassifiseres, og brukes til køllelengder, runder, baneanbefalinger og strategi ute.

| Mappe | Innhold |
|---|---|
| `app/` | Selve appen (PWA, ren HTML/JS uten byggesteg). Publiseres til GitHub Pages ved hver endring. |
| `extension/` | Chrome-utvidelsen «My Caddie Sync» som henter TrackMan-data fra portalen i eierens nettleser. |
| `supabase/migrations/` | Databaseskjema og funksjoner (Postgres i Supabase). |
| `supabase/functions/` | Edge-funksjoner (henter TrackMans offentlige baneliste). |
| `importer/` | Reserve: import av TrackMan-CSV. |

## Sikkerhet
- Ingen hemmeligheter i koden. `app/config.js` inneholder bare den offentlige («publishable») Supabase-nøkkelen.
- Alle data er beskyttet av innlogging og radnivåsikkerhet (RLS) i Supabase. Bare eieren kan lese eller endre noe.
- TrackMan-innloggingen forlater aldri eierens nettleser.

## Datakilder
- TrackMan Portal (egen konto) via utvidelsen.
- TrackMans offentlige banekatalog.
- Kart og hull ute: © OpenStreetMap-bidragsytere (ODbL). Flyfoto: Esri World Imagery.
