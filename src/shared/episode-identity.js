// LST episode identity.
//
// One owner for the judgments LST makes about *what an episode is*: which names
// a streaming service actually gave us and which are placeholders it renders
// when it has nothing better, where the episode marker sits inside a title, what
// the title block embedded in Netflix's episode HTML says, and the cache id that
// ties stored translations to a video.
//
// A cache id belongs to one service as well as one video. Netflix keys are the
// un-namespaced form they have always been, so every cache written before Prime
// Video support still resolves; a second service is namespaced with the
// unreserved `~`, which `encodeURIComponent` never produces. Which service a key
// belongs to is decided by the key itself — `decodeCacheId` — not by whoever is
// asking, so a Prime episode can never be filed under Netflix or the other way
// round.
//
// The same questions used to be answered in four files with four different
// vocabularies. content.js, background.js, popup.js and options.js each had
// their own idea of what a placeholder episode name looks like, so the same
// name could be a placeholder in one place and a real name in another, and a
// differently worded placeholder could overwrite a real episode name that had
// already been found. The rules live here instead, once, and every answer
// carries the reason it was given. A question this file cannot answer is
// reported as unanswered rather than guessed at.
//
// Nothing here touches the network, the DOM, or browser storage. It is pure
// text and object handling, so the background, a content script, and the
// extension's own pages can all load it without depending on each other.

(() => {
  const UNKNOWN_VIDEO_ID = "unknown";

  // The un-namespaced cache id form belongs to Netflix, which is the service
  // that wrote every cache before Prime Video support existed.
  const DEFAULT_SITE_ID = "netflix";

  // Which service a cache id can be namespaced by, and what each one is called.
  // playback-site.js owns the authoritative list and labels; these are the
  // fallbacks for a broken load order, so naming degrades into a stated reason
  // instead of an exception.
  const SITE_LABELS = Object.freeze({
    netflix: "Netflix",
    primevideo: "Prime Video",
    // Extension-owned playback is not a web-service adapter: it has no host,
    // match pattern, page hook, or content script. It still needs a namespace
    // so a local file's cache can never collide with a streaming title.
    local: "Local Video",
  });

  // Recognised video id shapes. Netflix uses numeric ids; Prime Video uses the
  // ASIN and Amazon's GTI identifier. An id that matches none of them is not
  // treated as "known", because a cache keyed on a guess would be unfindable.
  const VIDEO_ID_SHAPES = Object.freeze([
    { kind: "netflix-id", pattern: /^\d+$/ },
    { kind: "asin", pattern: /^[A-Z0-9]{10}$/ },
    { kind: "prime-gti", pattern: /^amzn1\.dv\.gti\.[A-Za-z0-9._-]+$/i },
    { kind: "local-media", pattern: /^local-[a-f0-9]{16}$/ },
  ]);

  // What a name turned out to be. "unknown" is never returned by classifyName:
  // it exists so a caller that cannot reach this file has something honest to
  // say, rather than silently inventing an answer.
  const NAME_KIND = Object.freeze({
    empty: "empty",
    placeholder: "placeholder",
    specific: "specific",
  });

  // Placeholder names Netflix renders when it has nothing better. Ordered, and
  // anchored to the whole value: "Episode 5 · Pilot" is a real name, while
  // "Episode 5" alone is only the episode number with no title to go with it.
  // Each shape says why it is a placeholder, so a wrong classification can be
  // traced to the rule that produced it.
  const PLACEHOLDER_SHAPES = Object.freeze([
    {
      shape: "netflix-brand",
      reason: "netflix-brand-only",
      pattern: /^Netflix(?:\s*[-–—|:].*)?$/i,
    },
    {
      shape: "netflix-episode-id",
      reason: "video-id-placeholder",
      pattern: /^Netflix episode \S+$/i,
    },
    {
      shape: "prime-brand",
      reason: "prime-brand-only",
      pattern: /^Prime Video(?:\s*[-–—|:].*)?$/i,
    },
    {
      shape: "amazon-brand",
      reason: "prime-brand-only",
      pattern: /^Amazon(?:\.[a-z]{2,3})?(?:\.[a-z]{2})?(?:\s*[-–—|:].*)?$/i,
    },
    {
      shape: "prime-episode-id",
      reason: "video-id-placeholder",
      pattern: /^Prime Video episode \S+$/i,
    },
    {
      shape: "episode-details-unavailable",
      reason: "netflix-title-unavailable",
      pattern: /^Episode details unavailable$/i,
    },
    {
      shape: "unknown-netflix-episode",
      reason: "netflix-title-unavailable",
      pattern: /^Unknown Netflix episode$/i,
    },
    {
      shape: "unknown-prime-episode",
      reason: "prime-title-unavailable",
      pattern: /^Unknown Prime Video episode$/i,
    },
    {
      shape: "unknown-episode",
      reason: "video-id-unknown",
      pattern: /^Unknown episode$/i,
    },
    {
      shape: "episode-id",
      reason: "video-id-placeholder",
      pattern: /^Episode \S+$/i,
    },
    {
      shape: "video-id",
      reason: "video-id-placeholder",
      pattern: /^Video \S+$/i,
    },
  ]);

  // Episode markers inside a title. Ordered: a season-and-episode marker is
  // more specific than a bare episode number, and the bare number pattern would
  // otherwise match the tail of "S1E5". The season separator is optional
  // because Netflix writes "S1:E5", "S1E5", and "Season 1 Episode 5" alike.
  const EPISODE_MARKER_SHAPES = Object.freeze([
    {
      shape: "season-episode",
      pattern: /\bS(?:eason)?\s*(\d+)\s*[:·\-–—]?\s*E(?:pisode)?\s*(\d+)\b/i,
    },
    {
      shape: "episode-number",
      pattern: /\bE(?:pisode)?\s*(\d+)\b/i,
    },
  ]);

  // Remote providers whose cache ids carry "provider/model" in the model slot.
  const REMOTE_PROVIDER_PREFIXES = Object.freeze(["deepseek", "gemini"]);

  const UNRECOGNIZED_MODEL = "Unknown model";
  const UNRECOGNIZED_LANGUAGE = "Unknown language";

  // Identity fields are derived from the cache id, which is also the storage
  // key, so the id — not the caller — decides them. That includes the service:
  // a cache namespaced for Prime Video is a Prime Video cache no matter what a
  // page reports about itself.
  const IDENTITY_FIELDS = Object.freeze([
    "videoId",
    "siteId",
    "provider",
    "model",
    "targetLanguage",
  ]);

  // Descriptive fields are scraped from a page that changes under us, so they
  // are decided by what kind of name they are rather than by who sent them.
  const DESCRIPTIVE_FIELDS = Object.freeze(["showName", "episodeName", "title"]);

  function normalizeName(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function siteLabel(siteId) {
    const id = String(siteId || "");
    if (!id) return SITE_LABELS[DEFAULT_SITE_ID];
    const api = globalThis.LSTPlaybackSite;
    return api?.labelFor?.(id) || SITE_LABELS[id] || id;
  }

  function isKnownSiteId(siteId) {
    const id = String(siteId || "");
    if (!id) return false;
    const api = globalThis.LSTPlaybackSite;
    return (
      Object.prototype.hasOwnProperty.call(SITE_LABELS, id) ||
      (Array.isArray(api?.SITE_IDS) && api.SITE_IDS.includes(id))
    );
  }

  // A service is namespaced into the cache id only when it is not the default
  // one, so every Netflix key stays byte-identical to the keys already stored.
  function isNamespacedSite(siteId) {
    const id = String(siteId || "");
    return Boolean(id) && id !== DEFAULT_SITE_ID && isKnownSiteId(id);
  }

  // An episode key names one episode of one service and nothing else. A cache
  // id also names the model and the target language, so it changes when the
  // viewer switches model; an imported subtitle file belongs to the episode, not
  // to the model that happened to be selected when it was imported, and is keyed
  // by this instead. The service namespace rule is the cache id's rule, so the
  // two spellings of the same episode cannot drift apart.
  function encodeEpisodeKey({ videoId, siteId } = {}) {
    const value = String(videoId ?? "").trim();
    if (!isKnownVideoId(value)) return "";
    const namespace = isNamespacedSite(siteId) ? `${siteId}~` : "";
    return `${namespace}${value}`;
  }

  // A show key names one show on one service. An imported subtitle file and the
  // translations cached for it are keyed by episode, but what LST learned *about
  // a show* — what Jimaku holds for it — belongs to every episode of that show,
  // so it needs a key of its own.
  //
  // The services state no show id on a watch page, so the key is made from the
  // show's name: letters and digits of any script, lower-cased, separated by
  // single hyphens. A placeholder name states no show at all, and a name with no
  // letter or digit in it cannot be a key, so both answer "" — a fact filed under
  // "Netflix" would be found again on every Netflix page, which is worse than
  // having no fact at all.
  const SHOW_KEY_MAX_LENGTH = 80;

  function showKeyShape(showName) {
    const shape = normalizeName(showName)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    return shape.slice(0, SHOW_KEY_MAX_LENGTH).replace(/-+$/g, "");
  }

  function encodeShowKey({ showName, siteId } = {}) {
    const classified = classifyName(showName);
    if (classified.kind !== NAME_KIND.specific) return "";
    const shape = showKeyShape(classified.name);
    if (!shape) return "";
    const namespace = isNamespacedSite(siteId) ? `${siteId}~` : "";
    return `${namespace}${shape}`;
  }

  function decodeEpisodeKey(episodeKey) {
    const raw = String(episodeKey ?? "").trim();
    if (!raw) {
      return { videoId: "", siteId: "", namespace: "none", reason: "empty-episode-key" };
    }
    const namespaceMatch = raw.match(/^([a-z0-9]+)~/);
    let siteId = DEFAULT_SITE_ID;
    let namespace = "legacy";
    let body = raw;

    if (namespaceMatch) {
      if (!isKnownSiteId(namespaceMatch[1])) {
        return {
          videoId: "",
          siteId: "",
          namespace: "unknown",
          reason: "unknown-site-namespace",
        };
      }
      siteId = namespaceMatch[1];
      namespace = "site";
      body = raw.slice(namespaceMatch[0].length);
    }

    if (body.includes(":") || !isKnownVideoId(body)) {
      return { videoId: "", siteId, namespace, reason: "unrecognized-video-id" };
    }
    return { videoId: body, siteId, namespace, reason: "ok" };
  }

  // Which shape of id this is, or "" when it matches none of the known ones.
  function videoIdKind(videoId) {
    const value = String(videoId ?? "");
    if (!value) return "";
    for (const entry of VIDEO_ID_SHAPES) {
      if (entry.pattern.test(value)) return entry.kind;
    }
    return "";
  }

  function isKnownVideoId(videoId) {
    const value = String(videoId ?? "");
    if (!value || value === UNKNOWN_VIDEO_ID) return false;
    return Boolean(videoIdKind(value));
  }

  // A service can glue onto the show's own name the marker that says *which*
  // part of the show this page is: "Homeland - Season 2", "Show - S2",
  // "機動戦士ガンダム 水星の魔女 シーズン1", "Show 第2期". The marker is not the
  // show's name — the same show is on the next episode's page under the same
  // name without it — so a name LST stores, groups by, or searches with does not
  // carry one. Only a *trailing* marker is removed, so a title that mentions a
  // season in the middle of its name is left alone, and an episode marker is not
  // touched at all: "Show: Episode 1" names an episode, and the episode is what
  // a caller asking about an episode is asking about.
  //
  // subtitle-import.js keeps its own, wider vocabulary for a search query: a
  // query also drops an episode marker, a bare trailing number and an ordinal
  // season ("Show - 3", "Show 3rd Season"), which a title may legitimately be
  // called.
  const SHOW_NAME_TRAILERS = Object.freeze([
    { shape: "season-separator", pattern: /\s*[-–—|:·、：・]\s*(?:season|series|staffel|saison|temporada)\s*\d{1,3}\s*$/i },
    { shape: "season-word", pattern: /\s*(?:season|series|staffel|saison|temporada)\s*\d{1,3}\s*$/i },
    { shape: "season-ordinal", pattern: /\s*\d{1,3}(?:st|nd|rd|th)\s+(?:season|series)\s*$/i },
    { shape: "season-short", pattern: /\s*[-–—|:·、：・]\s*s\d{1,2}\s*$/i },
    { shape: "japanese-season", pattern: /\s*(?:第\s*)?\d{1,2}\s*(?:シーズン|クール|期|季|部)\s*$/ },
    { shape: "japanese-season-word", pattern: /\s*(?:シーズン|パート)\s*\d{1,2}\s*$/ },
  ]);

  // The separator a trimmed marker leaves behind ("Show - 第2期"), and the
  // punctuation a service hangs off a name.
  const DANGLING_SEPARATOR = /[-–—|:·、：・]+$/;

  function placeholderShape(name) {
    for (const entry of PLACEHOLDER_SHAPES) {
      if (entry.pattern.test(name)) return entry;
    }
    return null;
  }

  // The name a title states once the markers it glued on are gone, and which
  // markers were removed. A trim that would leave nothing, or leave a
  // placeholder where a name was ("Season 1 · Episode 50 · The Beginning" is
  // entirely markers once you take the words out), removed the name itself: the
  // words it took were the name, so the name stands.
  function stripShowTrailers(value) {
    const original = normalizeName(value);
    if (!original) return { name: "", markers: [] };
    let working = original;
    const markers = [];
    for (let pass = 0; pass <= SHOW_NAME_TRAILERS.length; pass += 1) {
      let changed = false;
      for (const entry of SHOW_NAME_TRAILERS) {
        const next = working
          .replace(entry.pattern, "")
          .replace(DANGLING_SEPARATOR, "")
          .trim();
        if (next === working) continue;
        working = next;
        markers.push(entry.shape);
        changed = true;
      }
      if (!changed) break;
    }
    if (!markers.length) return { name: original, markers: [] };
    if (!working || placeholderShape(working)) {
      return { name: original, markers: [] };
    }
    return { name: working, markers };
  }

  // The show a page's title names, which is the same name on every episode of
  // that show: 機動戦士ガンダム 水星の魔女 シーズン1 names 機動戦士ガンダム 水星の魔女.
  function showNameFromTitle(value) {
    return stripShowTrailers(value).name;
  }

  // The single answer to "is this a real name or a placeholder?".
  function classifyName(value) {
    const name = normalizeName(value);
    if (!name) {
      return { name: "", kind: NAME_KIND.empty, reason: "empty-name", shape: "" };
    }
    // A placeholder is a placeholder whole, before any marker is considered: a
    // name the service renders when it has nothing better is not a show with a
    // season on the end of it.
    const placeholder = placeholderShape(name);
    if (placeholder) {
      return {
        name,
        kind: NAME_KIND.placeholder,
        reason: placeholder.reason,
        shape: placeholder.shape,
      };
    }
    const stripped = stripShowTrailers(name);
    if (stripped.name !== name) {
      return {
        name: stripped.name,
        kind: NAME_KIND.specific,
        reason: "specific-name-after-marker",
        shape: "",
        marker: stripped.markers[stripped.markers.length - 1] || "",
      };
    }
    return {
      name,
      kind: NAME_KIND.specific,
      reason: "specific-name",
      shape: "",
    };
  }

  function isSpecificName(value) {
    return classifyName(value).kind === NAME_KIND.specific;
  }

  function isPlaceholderName(value) {
    const classified = classifyName(value);
    return classified.kind === NAME_KIND.placeholder;
  }

  // The name to show when several sources disagree: a real name beats a
  // placeholder, and among equal kinds the caller's order decides.
  function preferredName(...values) {
    for (const value of values) {
      const classified = classifyName(value);
      if (classified.kind === NAME_KIND.specific) return classified;
    }
    for (const value of values) {
      const classified = classifyName(value);
      if (classified.kind === NAME_KIND.placeholder) return classified;
    }
    return { name: "", kind: NAME_KIND.empty, reason: "empty-name", shape: "" };
  }

  // The one placeholder LST writes when Netflix has not told us the episode
  // number or title. It is derived from the video id, so it is recognizable by
  // shape and never has to be compared against one exact expected string.
  function fallbackEpisodeName(videoId) {
    return isKnownVideoId(videoId)
      ? `Episode ${videoId}`
      : "Episode details unavailable";
  }

  function fallbackTitle(videoId, siteId = DEFAULT_SITE_ID) {
    const label = siteLabel(siteId);
    return isKnownVideoId(videoId)
      ? `${label} episode ${videoId}`
      : `Unknown ${label} episode`;
  }

  // How LST writes an episode name once it knows something real about it.
  // The number alone is never a name, so a missing one leaves no trace.
  function episodeNameFromParts({ episodeNumber, title } = {}) {
    const label = episodeNumber == null ? "" : `Episode ${episodeNumber}`;
    return [label, normalizeName(title)].filter(Boolean).join(" · ");
  }

  // Where the episode marker sits inside a title, and which rule found it.
  function episodeMarker(text) {
    const value = normalizeName(text);
    if (!value) {
      return {
        marker: "",
        season: null,
        episode: null,
        shape: "",
        reason: "empty-text",
      };
    }
    for (const entry of EPISODE_MARKER_SHAPES) {
      const match = value.match(entry.pattern);
      if (!match) continue;
      if (entry.shape === "season-episode") {
        const season = Number(match[1]);
        const episode = Number(match[2]);
        return {
          marker: `Season ${season} · Episode ${episode}`,
          season,
          episode,
          shape: entry.shape,
          reason: "season-episode-marker",
        };
      }
      const episode = Number(match[1]);
      return {
        marker: `Episode ${episode}`,
        season: null,
        episode,
        shape: entry.shape,
        reason: "episode-number-marker",
      };
    }
    return {
      marker: "",
      season: null,
      episode: null,
      shape: "",
      reason: "no-episode-marker",
    };
  }

  function decodeEmbeddedText(value) {
    return normalizeName(value)
      .replace(/\\x20/g, " ")
      .replace(/\\n/g, " ")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  // Index of the brace that closes the object the scan started inside, ignoring
  // braces that appear inside JSON string literals.
  function flatObjectEnd(source, from) {
    let inString = false;
    let escaped = false;
    for (let index = from; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "}") return index;
    }
    return -1;
  }

  // The innermost object that contains `index`, found by tracking brace depth
  // outside string literals. Braces close innermost first, so the first frame
  // that closes around the index is the object the index lives in. Scanning
  // stops as soon as that frame closes, so the cost follows where the video id
  // sits in the page rather than the size of the page.
  function enclosingObjectSpan(source, index) {
    const openers = [];
    let inString = false;
    let escaped = false;
    for (let position = 0; position < source.length; position += 1) {
      const character = source[position];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        openers.push(position);
        continue;
      }
      if (character !== "}") continue;
      const start = openers.pop();
      if (start == null) continue;
      if (start <= index && index <= position) return [start, position];
      // An object that opened after the index cannot contain it, and nothing
      // later can either.
      if (start > index) break;
    }
    return null;
  }

  // The episode title and number Netflix embeds next to a video id in the
  // episode page HTML. The companion fields are read from the object that holds
  // the video id rather than from a fixed number of characters after it, so the
  // result does not depend on field order, on whitespace, or on how much
  // Netflix puts between the two. Every way of coming up empty has a reason.
  function findEpisodeMetadataInHtml(html, videoId) {
    const source = String(html ?? "");
    if (!isKnownVideoId(videoId)) {
      return { episodeNumber: null, title: "", reason: "video-id-unknown" };
    }

    const videoIdPattern = /"?videoId"?\s*:\s*"?(\d+)"?/g;
    let match = videoIdPattern.exec(source);
    while (match && match[1] !== String(videoId)) {
      match = videoIdPattern.exec(source);
    }
    if (!match) {
      return { episodeNumber: null, title: "", reason: "video-id-not-found" };
    }

    const span = enclosingObjectSpan(source, match.index);
    let block;
    if (span) {
      block = source.slice(span[0], span[1] + 1);
    } else {
      // The video id is not inside a balanced object anywhere Netflix's markup
      // ends up like that, but read what follows it rather than give up.
      const end = flatObjectEnd(source, match.index + match[0].length);
      block = source.slice(match.index, end === -1 ? source.length : end + 1);
    }
    const titleMatch = block.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const numberMatch = block.match(/"number"\s*:\s*(\d+)/);
    const title = titleMatch ? decodeEmbeddedText(titleMatch[1]) : "";
    const episodeNumber = numberMatch ? Number(numberMatch[1]) : null;

    if (!title && episodeNumber == null) {
      return {
        episodeNumber: null,
        title: "",
        reason: "episode-metadata-not-found",
      };
    }
    if (!title) {
      return { episodeNumber, title: "", reason: "episode-title-missing" };
    }
    if (episodeNumber == null) {
      return { episodeNumber: null, title, reason: "episode-number-missing" };
    }
    return { episodeNumber, title, reason: "ok" };
  }

  // Cache ids are "<videoId>:encoded owner:encoded target language", optionally
  // namespaced for a service other than Netflix as
  // "<siteId>~<videoId>:…". The split is taken from the first and last separator
  // rather than by splitting on every colon, so a model name that contains a
  // colon can never shift the language, and `~` is unreserved so it can never be
  // produced by the encoded owner or language.
  function encodeCacheId({
    videoId,
    model,
    provider,
    targetLanguage,
    siteId,
  } = {}) {
    const owner = provider && provider !== "ollama"
      ? `${provider}/${model || "none"}`
      : model || "none";
    const namespace = isNamespacedSite(siteId) ? `${siteId}~` : "";
    return [
      `${namespace}${isKnownVideoId(videoId) ? String(videoId) : UNKNOWN_VIDEO_ID}`,
      encodeURIComponent(owner),
      encodeURIComponent(targetLanguage || "English"),
    ].join(":");
  }

  function decodeCachePart(value, fallback) {
    try {
      return decodeURIComponent(value || "") || fallback;
    } catch {
      return value || fallback;
    }
  }

  function decodeCacheId(cacheId) {
    const raw = String(cacheId ?? "");
    const namespaceMatch = raw.match(/^([a-z0-9]+)~/);
    let siteId = DEFAULT_SITE_ID;
    let namespace = "legacy";
    let body = raw;

    if (namespaceMatch) {
      if (!isKnownSiteId(namespaceMatch[1])) {
        return {
          videoId: null,
          siteId: "",
          provider: "",
          model: "",
          targetLanguage: "",
          namespace: "unknown",
          reason: "unknown-site-namespace",
        };
      }
      siteId = namespaceMatch[1];
      namespace = "site";
      body = raw.slice(namespaceMatch[0].length);
    }

    const firstSeparator = body.indexOf(":");
    const lastSeparator = body.lastIndexOf(":");
    if (firstSeparator < 0 || lastSeparator === firstSeparator) {
      return {
        videoId: null,
        siteId,
        provider: "",
        model: "",
        targetLanguage: "",
        namespace,
        reason: "malformed-cache-id",
      };
    }

    const videoId = body.slice(0, firstSeparator);
    const owner = decodeCachePart(body.slice(firstSeparator + 1, lastSeparator), "");
    const targetLanguage = decodeCachePart(body.slice(lastSeparator + 1), "");
    const remote = REMOTE_PROVIDER_PREFIXES
      .map((provider) => owner.match(
        new RegExp(`^${provider}/(.+)$`, "i"),
      ))
      .find(Boolean);

    return {
      videoId: isKnownVideoId(videoId) ? videoId : null,
      siteId,
      provider: remote ? owner.slice(0, owner.indexOf("/")) : "ollama",
      model: remote ? remote[1] : owner,
      targetLanguage,
      namespace,
      // An un-namespaced key resolves to Netflix by the rule that predates the
      // namespace, and says so, rather than by falling through to a default.
      reason: !isKnownVideoId(videoId)
        ? "video-id-unknown"
        : namespace === "legacy"
          ? "legacy-cache-id"
          : "ok",
    };
  }

  // What can be said about a stored translation from its cache id alone. This
  // is the floor every other source of metadata is merged onto. The service the
  // key is namespaced for — or Netflix, for an un-namespaced key — decides the
  // show name, so a Prime Video cache is never grouped under Netflix.
  function inferCacheMetadata(cacheId) {
    const decoded = decodeCacheId(cacheId);
    const videoId = decoded.videoId || UNKNOWN_VIDEO_ID;
    const siteId = decoded.siteId || DEFAULT_SITE_ID;
    return {
      videoId,
      siteId,
      showName: siteLabel(siteId),
      episodeName: fallbackEpisodeName(videoId),
      title: fallbackTitle(videoId, siteId),
      provider: decoded.provider || "ollama",
      model: decoded.model || UNRECOGNIZED_MODEL,
      targetLanguage: decoded.targetLanguage || UNRECOGNIZED_LANGUAGE,
      reason: decoded.reason,
    };
  }

  function isUnrecognizedIdentity(field, value) {
    if (value == null || value === "") return true;
    if (field === "videoId") return !isKnownVideoId(value);
    if (field === "siteId") return !isKnownSiteId(value);
    if (field === "model") return value === UNRECOGNIZED_MODEL;
    if (field === "targetLanguage") return value === UNRECOGNIZED_LANGUAGE;
    return false;
  }

  // Combine what the cache id says, what is already stored, and what the page
  // just reported. Identity follows the cache id, because the id is also the
  // storage key and a cache that disagreed with its own key would be unfindable.
  // A real name always beats a placeholder, whichever source it came from, so a
  // differently worded placeholder can no longer erase a name we already found.
  // Every field records the decision that produced it.
  function mergeCacheMetadata({ inferred, existing, incoming } = {}) {
    const base = inferred || {};
    const stored = existing || {};
    const observed = incoming || {};
    const decisions = [];
    const merged = { ...base };

    for (const field of IDENTITY_FIELDS) {
      const value = observed[field];
      if (value == null || value === "") continue;
      if (isUnrecognizedIdentity(field, base[field])) {
        merged[field] = value;
        decisions.push({
          field,
          decision: "adopted-incoming-identity",
          reason: "cache-id-unrecognized",
          source: "incoming",
        });
      } else if (isUnrecognizedIdentity(field, value)) {
        decisions.push({
          field,
          decision: "kept-cache-id-identity",
          reason: "incoming-identity-unrecognized",
          source: "cache-id",
        });
      } else if (String(value) !== String(base[field])) {
        decisions.push({
          field,
          decision: "kept-cache-id-identity",
          reason: "incoming-identity-differs",
          source: "cache-id",
        });
      } else {
        decisions.push({
          field,
          decision: "kept-cache-id-identity",
          reason: "identities-agree",
          source: "cache-id",
        });
      }
    }

    for (const field of DESCRIPTIVE_FIELDS) {
      const candidates = [
        { source: "incoming", value: observed[field] },
        { source: "existing", value: stored[field] },
      ];
      const specific = candidates.find(
        (candidate) => classifyName(candidate.value).kind === NAME_KIND.specific,
      );
      if (specific) {
        const classified = classifyName(specific.value);
        merged[field] = classified.name;
        const displaced = candidates.find(
          (candidate) => candidate.source !== specific.source,
        );
        const displacedName = classifyName(displaced?.value);
        decisions.push({
          field,
          decision: specific.source === "incoming"
            ? (displacedName.kind === NAME_KIND.specific
                ? "replaced-specific-name"
                : "adopted-specific-name")
            : "kept-specific-name",
          reason: specific.source === "incoming"
            ? "newer-specific-name"
            : "stored-specific-name",
          source: specific.source,
          displacedKind: displacedName.kind,
          displacedReason: displacedName.reason,
        });
        continue;
      }

      const placeholder = candidates.find(
        (candidate) => classifyName(candidate.value).kind === NAME_KIND.placeholder,
      );
      if (placeholder) {
        const classified = classifyName(placeholder.value);
        merged[field] = classified.name;
        decisions.push({
          field,
          decision: "kept-placeholder-name",
          reason: classified.reason,
          source: placeholder.source,
        });
        continue;
      }

      merged[field] = merged[field] == null ? "" : merged[field];
      decisions.push({
        field,
        decision: "no-name-observed",
        reason: "empty-name",
        source: "cache-id",
      });
    }

    for (const [field, value] of [
      ...Object.entries(stored),
      ...Object.entries(observed),
    ]) {
      if (IDENTITY_FIELDS.includes(field) || DESCRIPTIVE_FIELDS.includes(field)) {
        continue;
      }
      if (value == null || value === "") continue;
      merged[field] = value;
    }

    return { metadata: merged, decisions };
  }

  const api = {
    UNKNOWN_VIDEO_ID,
    DEFAULT_SITE_ID,
    NAME_KIND,
    PLACEHOLDER_SHAPES,
    EPISODE_MARKER_SHAPES,
    VIDEO_ID_SHAPES,
    classifyName,
    decodeCacheId,
    decodeEpisodeKey,
    encodeCacheId,
    encodeEpisodeKey,
    encodeShowKey,
    episodeMarker,
    episodeNameFromParts,
    fallbackEpisodeName,
    fallbackTitle,
    findEpisodeMetadataInHtml,
    inferCacheMetadata,
    isKnownSiteId,
    isKnownVideoId,
    isNamespacedSite,
    isPlaceholderName,
    isSpecificName,
    mergeCacheMetadata,
    normalizeName,
    preferredName,
    showKeyShape,
    showNameFromTitle,
    stripShowTrailers,
    siteLabel,
    videoIdKind,
  };

  globalThis.LSTEpisodeIdentity = api;
  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
