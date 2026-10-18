export const TEMPLATE_HELP = {
  syntax: [
    { example: "{game_name}", note: "Insert a variable. Missing values render as \"unavailable\", never invented." },
    { example: "{timestamp:F}", note: "Variable with an argument (dates, manifest lookup)." },
    { example: "{game_name|upper|truncate:20}", note: "Filters, chained left to right: upper, lower, trim, code, escape, truncate:N, default:TEXT." },
    { example: "{#if manifest_id}...{#else}...{/if}", note: "Conditional. Prefix the name with ! to negate." },
    { example: "{#each depots}{depot_id}: {manifest_id}\\n{/each}", note: "Loop over changed depots. Loop variables: depot_id, manifest_id, prev_manifest_id, change." },
    { example: "{{ and }}", note: "Literal braces." },
  ],
  variables: [
    ["game_name", "Game name"], ["app_id", "Steam App ID"], ["build_id", "New build ID"], ["prev_build_id", "Previous build ID"],
    ["branch", "Steam branch"], ["kind", "update | rollback | initial"], ["kind_label", "updated | rolled back"], ["event_id", "ManifestHound event ID"],
    ["depot_ids", "Changed depot IDs, comma separated"], ["depot_count", "Number of changed depots"],
    ["manifest_id", "Changed manifest ID (several: comma separated)"], ["manifest_ids", "One line per changed depot using the manifest format (default \"{depot_id}: {manifest_id}\")"],
    ["manifest:DEPOT", "Manifest ID of a specific depot, e.g. {manifest:481}"],
    ["history_url", "Link to this event in the local dashboard"], ["steamdb_url", "SteamDB link for the app"], ["store_url", "Steam store link"],
  ],
  dates: [
    { example: "{timestamp}", note: "Discord full timestamp <t:UNIX:F> from the actual update (or detection) time" },
    { example: "{timestamp:R}", note: "Discord style: t T d D f F R (R = relative, \"2 minutes ago\")" },
    { example: "{timestamp:YYYY-MM-DD HH:mm}", note: "Literal date formatted in the selected timezone" },
    { example: "{date:YYYY-MM-DD}", note: "Date only (default YYYY-MM-DD)" },
    { example: "{time:HH:mm:ss}", note: "Time only" }, { example: "{datetime}", note: "YYYY-MM-DD HH:mm:ss z" },
    { example: "{unix}", note: "Unix seconds" }, { example: "{iso}", note: "ISO-8601 UTC" },
    { example: "{detected_at:R} / {update_time:F}", note: "The detection time vs. the time Steam reports for the update (unavailable if Steam gave none)" },
  ],
  formatTokens: "YYYY YY MMMM MMM MM M dddd ddd DD D HH H hh h mm m ss s SSS A a Z ZZ z X x; literal text in [brackets]",
  timezone: "Choose UTC or a local IANA timezone (e.g. America/New_York) in Settings > Notifications or per game. Discord <t:> timestamps always show in each reader's own timezone.",
};
