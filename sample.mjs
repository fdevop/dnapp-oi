/**
 * sample.mjs — one sample of the Variational market denominator, appended to a daily file.
 *
 * Why this exists at all: the venue publishes open interest and 24 h volume as a SNAPSHOT and
 * keeps no history of either (`from`/`to`/`interval` are ignored, answered 200; eleven history
 * paths 404). Any percentage of the market in the past therefore needs a denominator that only
 * exists if someone wrote it down at the time. This writes it down.
 *
 * It is the last of three recorders, each covering what the previous one cannot:
 *   - DNApp itself samples every 10 min while it is open;
 *   - this runs on a schedule whether or not any machine of yours is on.
 *
 * No dependencies, Node 20+ (built-in fetch). The endpoint is public: no key, no cookie, and
 * `access-control-allow-origin: *`.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STATS_URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'
const DATA_DIR  = 'data'

/** Instruments worth recording. Everything else is a denominator nothing will ever divide by. */
const universe = JSON.parse(readFileSync('universe.json', 'utf8'))
if (!Array.isArray(universe) || universe.length === 0) {
  console.error('universe.json is empty — nothing to record')
  process.exit(1)
}

const res = await fetch(STATS_URL, { headers: { 'accept-encoding': 'gzip' } })
if (!res.ok) {
  console.error(`stats → HTTP ${res.status}`)
  process.exit(1)
}
const { listings = [] } = await res.json()

const byTicker = new Map()
for (const l of listings) if (l.ticker) byTicker.set(l.ticker, l)

const num = (s) => {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

const by = {}
const missing = []
for (const key of universe) {
  const l = byTicker.get(key)
  const px = l ? num(l.mark_price) : null
  const long  = l ? num(l.open_interest?.long_open_interest) : null
  const short = l ? num(l.open_interest?.short_open_interest) : null
  // Un instrument absent du listing est SIGNALÉ, jamais compté zéro : un zéro se propagerait
  // en dénominateur et rendrait des pourcentages infinis.
  if (px == null || long == null || short == null) { missing.push(key); continue }
  by[key] = {
    // Arrondi au dollar : la précision au centime sur un OI de 100 M n'apporte rien et
    // multiplie le poids du fichier.
    oi:  Math.round(long + short),
    vol: Math.round(num(l.volume_24h) ?? 0),
    px:  Number(px.toPrecision(8)),
  }
}

if (Object.keys(by).length === 0) {
  console.error('nothing matched the universe — not writing an empty sample', { missing })
  process.exit(1)
}

const t = Date.now()
// Fichiers JOURNALIERS, et non mensuels : DNApp ne télécharge alors que les journées qui lui
// manquent, au lieu de re-tirer tout un mois à chaque fois.
const day = new Date(t).toISOString().slice(0, 10)
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
appendFileSync(join(DATA_DIR, `${day}.jsonl`), JSON.stringify({ t, by }) + '\n')

console.log(`sampled ${Object.keys(by).length}/${universe.length} → ${DATA_DIR}/${day}.jsonl`,
  missing.length ? `· missing: ${missing.join(', ')}` : '')
