# Message templates

| Syntax | Meaning |
|---|---|
| `{game_name}` | variable; missing values render as `unavailable` |
| `{timestamp:F}` | Discord timestamp `<t:UNIX:F>` from the real update time (styles t T d D f F R); bare `{timestamp}` = F |
| `{timestamp:YYYY-MM-DD HH:mm}` / `{date:YYYY-MM-DD}` | literal date in the chosen timezone (UTC or an IANA zone) |
| `{time}`, `{datetime}`, `{unix}`, `{iso}`, `{detected_at:R}`, `{update_time:F}` | other date views |
| `{x\|upper\|truncate:20}` | filters: upper lower trim code escape truncate:N default:TEXT |
| `{#if manifest_id}..{#else}..{/if}` | conditional (`!name` negates) |
| `{#each depots}{depot_id}: {manifest_id}{/each}` | loop over changed depots (`prev_manifest_id`, `change` also available) |
| `{manifest:481}` | manifest of a specific depot |
| `{{` `}}` | literal braces |

Variables: `game_name app_id build_id prev_build_id branch kind kind_label event_id depot_ids depot_count manifest_id manifest_ids manifest_count history_url steamdb_url store_url`.
`manifest_ids` uses the configurable manifest format (default `{depot_id}: {manifest_id}`).
Date tokens: `YYYY YY MMMM MMM MM M dddd ddd DD D HH H hh h mm m ss s SSS A a Z ZZ z X x`, literals in `[brackets]`.
Discord limits are enforced (content 2000, embed description 4096, field value 1024).
