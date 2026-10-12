// This function runs inside Spotify's CEF renderer. It uses discovered service
// names and shipped query definitions, never version-specific module numbers.
export async function spotifyRuntime(operation, args) {
  const fail = (code, message, details) => {
    throw Object.assign(new Error(message), { code, details });
  };
  const redact = (value) => {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(value ?? null, (key, item) => {
        if (/^(?:access_?token|refresh_?token|authorization|cookie|password|secret)$/i.test(key))
          return "[REDACTED]";
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "function") return undefined;
        if (item && typeof item === "object") {
          if (seen.has(item)) return undefined;
          seen.add(item);
        }
        return item;
      }),
    );
  };
  try {
    const element = document.getElementById("main");
    const rootKey = element && Object.keys(element).find((k) => k.startsWith("__reactContainer"));
    const root = rootKey && element[rootKey]?.stateNode?.current;
    if (!root) fail("NOT_READY", "Spotify UI is not ready. Finish login or wait for it to load.");
    const stack = [root],
      seen = new Set();
    let platform;
    while (stack.length && !platform) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      for (const value of Object.values(fiber.memoizedProps || {})) {
        if (
          value &&
          typeof value === "object" &&
          typeof value.getRegistry === "function" &&
          typeof value.getPlatformData === "function"
        ) {
          platform = value;
          break;
        }
      }
      stack.push(fiber.child, fiber.sibling);
    }
    if (!platform)
      fail(
        "NOT_READY",
        "Spotify service registry is unavailable. Finish login or wait for the UI.",
      );
    const registry = platform.getRegistry();
    const api = (name) => {
      const key = [...registry._map.keys()].find(
        (k) => (typeof k === "symbol" ? k.description : String(k)) === name,
      );
      if (key === undefined) fail("UNSUPPORTED", `${name} is unavailable in this Spotify build.`);
      return registry.resolve(key);
    };
    const call = async (name, method, values = []) => {
      const object = api(name);
      if (typeof object[method] !== "function")
        fail("UNSUPPORTED", `${name}.${method} is unavailable in this Spotify build.`);
      return await object[method](...values);
    };
    const uri = (input) => {
      if (input === "liked") return api("LibraryLikedSongsUri");
      if (typeof input !== "string")
        fail("INVALID_ARGUMENT", "A Spotify URI or open.spotify.com URL is required.");
      if (input.startsWith("https://open.spotify.com/")) {
        const parts = new URL(input).pathname.split("/").filter(Boolean);
        if (parts[0]?.startsWith("intl-")) parts.shift();
        input = `spotify:${parts[0]}:${parts[1]}`;
      }
      if (
        !/^spotify:(?:track|album|artist|playlist|episode|show|folder):[A-Za-z0-9]+$/.test(input) &&
        !/^spotify:user:[^:\s]+:(?:collection|folder:[A-Za-z0-9]+)$/.test(input) &&
        !/^spotify:local:[^\r\n]+$/.test(input)
      ) {
        fail("INVALID_ARGUMENT", "Expected a Spotify URI, an open.spotify.com URL, or liked.");
      }
      return input;
    };
    const uris = (input) => (Array.isArray(input) ? input : String(input).split(",")).map(uri);
    const item = (entry) => {
      if (!entry) return null;
      const data = entry.item?.data ?? entry.data ?? entry.track ?? entry.item ?? entry;
      const artists = Array.isArray(data.artists) ? data.artists : (data.artists?.items ?? []);
      return {
        uri: data.uri ?? data.entityInfo?.uri ?? null,
        type: data.type ?? data.uri?.split(":")[1] ?? null,
        name: data.name ?? data.profile?.name ?? data.title ?? null,
        artists: artists.map((a) => a.name ?? a.profile?.name).filter(Boolean),
        album: data.album?.name ?? data.albumOfTrack?.name ?? null,
        durationMs:
          data.duration?.milliseconds ??
          data.duration?.totalMilliseconds ??
          data.trackDuration?.totalMilliseconds ??
          null,
        uid: entry.uid ?? data.uid ?? entry.rowId ?? null,
        provider: data.provider ?? null,
        isPlayable: data.isPlayable ?? data.playability?.playable ?? null,
        ...(data.owner
          ? { owner: data.owner.displayName ?? data.owner.name ?? data.owner.username }
          : {}),
        ...(data.isOwnedBySelf !== undefined ? { owned: data.isOwnedBySelf } : {}),
        ...(data.items ? { items: data.items.map(item) } : {}),
      };
    };
    const page = (result) => ({
      items: (result.items ?? []).map(item),
      offset: result.offset ?? args.offset ?? 0,
      limit: result.limit ?? args.limit ?? null,
      total: result.totalLength ?? result.totalItemCount ?? null,
    });
    const status = async () => {
      const state = await call("PlayerAPI", "getState");
      const devices = await call("ConnectDevicesAPI", "getDevices");
      const volume = await call("PlaybackAPI", "getVolume");
      const elapsed =
        state && !state.isPaused && !state.isBuffering
          ? Math.max(0, Date.now() - state.timestamp)
          : 0;
      return {
        connected: true,
        username: platform.username,
        state: !state?.item ? "stopped" : state.isPaused ? "paused" : "playing",
        track: item(state?.item),
        context: state?.context?.uri ?? null,
        positionMs: state
          ? Math.min(state.duration || Infinity, state.positionAsOfTimestamp + elapsed)
          : 0,
        durationMs: state?.duration ?? 0,
        shuffle: state?.shuffle ?? false,
        smartShuffle: state?.smartShuffle ?? false,
        repeat: ["off", "context", "track"][state?.repeat ?? 0],
        volume: volume < 0 ? null : Math.round(volume * 100),
        device: devices?.find((d) => d.isActive)?.name ?? null,
        deviceId: devices?.find((d) => d.isActive)?.id ?? null,
        restrictions: state?.restrictions ?? {},
      };
    };
    const webpack = () => {
      window.__spotifyDesktopCli ??= {};
      if (!window.__spotifyDesktopCli.require) {
        const chunks = [window.webpackChunkclient_web, window.rspackChunk].find(Array.isArray);
        if (!Array.isArray(chunks)) fail("UNSUPPORTED", "Spotify module loader is unavailable.");
        chunks.push([
          [`spotify_desktop_cli_${Date.now()}`],
          {},
          (r) => {
            window.__spotifyDesktopCli.require = r;
          },
        ]);
      }
      return window.__spotifyDesktopCli.require;
    };
    const queryDefinitions = () => {
      const definitions = new Map();
      for (const factory of Object.values(webpack().m)) {
        for (const m of factory
          .toString()
          .matchAll(/new [\w$.]+\("([^"\n]+)","(query|mutation)","([a-f0-9]{64})"/g)) {
          definitions.set(m[1], { name: m[1], operation: m[2], sha256Hash: m[3], value: null });
        }
      }
      return definitions;
    };
    const loadRoute = async (route) => {
      const r = webpack();
      const match = [...r.u.toString().matchAll(/(\d+):"([^"]+)"/g)].find(
        (m) => m[2] === `xpui-routes-${route}`,
      );
      if (!match) fail("UNSUPPORTED", `Spotify's ${route} module is unavailable.`);
      await r.e(Number(match[1]));
    };
    const query = async (name, variables) => {
      const definition = queryDefinitions().get(name);
      if (!definition || definition.operation !== "query")
        fail(
          "UNSUPPORTED",
          `Read query ${name} is not loaded. Use queries --route ROUTE to discover shipped queries.`,
        );
      const response = await platform.getGraphQLLoader()(definition, variables);
      if (response.errors?.length)
        fail("QUERY_ERROR", response.errors.map((e) => e.message).join("; "));
      if (!response.data) fail("QUERY_ERROR", "Spotify returned no query data.");
      return response.data;
    };
    const search = async (options) => {
      if (!queryDefinitions().has("searchDesktop")) await loadRoute("search");
      const data = (
        await query(
          options.type === "all"
            ? "searchDesktop"
            : {
                track: "searchTracks",
                album: "searchAlbums",
                artist: "searchArtists",
                playlist: "searchPlaylists",
                episode: "searchEpisodes",
                show: "searchPodcasts",
                user: "searchUsers",
                audiobook: "searchAudiobooks",
              }[options.type],
          {
            searchTerm: options.query,
            offset: options.offset,
            limit: options.limit,
            numberOfTopResults: options.limit,
            includeAudiobooks: true,
            includeArtistHasConcertsField: false,
            includeLocalConcertsField: false,
            includePreReleases: false,
            includeAlbumPreReleases: false,
            includeAuthors: false,
            includeEpisodeContentRatingsV2: false,
          },
        )
      ).searchV2;
      if (!data) fail("QUERY_ERROR", "Search data is unavailable.");
      const categories = {
        tracks: "tracksV2",
        albums: "albumsV2",
        artists: "artists",
        playlists: "playlists",
        episodes: "episodes",
        shows: "podcasts",
        users: "users",
        audiobooks: "audiobooks",
        topResults: "topResultsV2",
      };
      return {
        query: options.query,
        offset: options.offset,
        limit: options.limit,
        ...Object.fromEntries(
          Object.entries(categories)
            .filter(([, key]) => data[key])
            .map(([name, key]) => [
              name,
              {
                items: (data[key].items ?? data[key].itemsV2 ?? []).map(item).filter((v) => v?.uri),
                total: data[key].totalCount ?? null,
              },
            ]),
        ),
      };
    };
    const playlist = async (input, offset = 0, limit = 20) => {
      const result = await call("PlaylistAPI", "getPlaylist", [uri(input), {}, { offset, limit }]);
      const m = result.metadata;
      return {
        uri: m.uri,
        name: m.name,
        description: m.description,
        owner: m.owner?.displayName,
        owned: m.isOwnedBySelf,
        saved: m.isSaved,
        published: m.isPublished,
        permissions: m.permissions,
        canEdit: m.canEditItems,
        ...page(result.contents),
      };
    };
    const findRow = async (target, uid) => {
      let offset = 0;
      for (;;) {
        const contents = await call("PlaylistAPI", "getContents", [
          target,
          { offset, limit: 1000 },
        ]);
        const index = contents.items.findIndex((row) => row.uid === uid);
        if (index !== -1) return { row: contents.items[index], index: offset + index };
        offset += contents.items.length;
        if (!contents.items.length || offset >= contents.totalLength) return null;
      }
    };
    const waitFor = async (read, predicate, message) => {
      const deadline = Date.now() + 6000;
      let observed;
      do {
        observed = await read();
        if (predicate(observed)) return observed;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      fail("STATE_NOT_CONFIRMED", message, { observed });
    };
    let result;
    switch (operation) {
      case "status":
        result = await status();
        break;
      case "search":
        result = await search(args);
        break;
      case "play": {
        if (args.uri && args.query)
          fail("INVALID_ARGUMENT", "Choose a URI or a search query, not both.");
        let selected = args.uri ? uri(args.uri) : null;
        if (args.query) {
          const found = await search({ query: args.query, type: "track", offset: 0, limit: 5 });
          selected = found.tracks?.items[0]?.uri;
          if (!selected) fail("NOT_FOUND", "No playable search result found.");
        }
        if (selected) {
          const context = args.context ? uri(args.context) : selected;
          const options = args.context ? { skipTo: { uri: selected } } : {};
          if (args.index !== undefined) options.skipTo = { index: args.index };
          await call("PlayerAPI", "play", [
            { uri: context },
            { featureIdentifier: "spotify-desktop-cli", featureVersion: "1.0.0" },
            options,
          ]);
          result = await waitFor(
            status,
            (s) =>
              s.state === "playing" &&
              (selected.startsWith("spotify:track:") || selected.startsWith("spotify:episode:")
                ? s.track?.uri === selected
                : s.context === context),
            "Playback was requested but not confirmed.",
          );
        } else {
          await call("PlayerAPI", "resume");
          result = await waitFor(
            status,
            (s) => s.state === "playing",
            "Resume was requested but not confirmed.",
          );
        }
        break;
      }
      case "pause":
      case "resume":
      case "toggle": {
        const current = await status();
        const pause =
          operation === "pause" || (operation === "toggle" && current.state === "playing");
        if (current.state !== (pause ? "paused" : "playing"))
          await call("PlayerAPI", pause ? "pause" : "resume");
        result = await waitFor(
          status,
          (s) => s.state === (pause ? "paused" : "playing"),
          "Playback state was not confirmed.",
        );
        break;
      }
      case "next":
      case "previous": {
        const before = (await status()).track?.uid;
        await call("PlayerAPI", operation === "next" ? "skipToNext" : "skipToPrevious");
        result = await waitFor(
          status,
          (s) => s.track?.uid !== before || (operation === "previous" && s.positionMs < 2000),
          "Track transition was not confirmed.",
        );
        break;
      }
      case "seek": {
        const state = await status();
        if (!state.track) fail("NOT_PLAYING", "No current track to seek.");
        const position = args.seconds * 1000;
        if (position > state.durationMs)
          fail("INVALID_ARGUMENT", "Seek position exceeds the track duration.");
        await call("PlayerAPI", "seekTo", [position]);
        result = await waitFor(
          status,
          (s) => Math.abs(s.positionMs - position) < 1500,
          "Seek position was not confirmed.",
        );
        break;
      }
      case "volume": {
        if (args.percent !== undefined)
          await call("PlaybackAPI", "setVolume", [args.percent / 100]);
        const read = async () => {
          const v = await call("PlaybackAPI", "getVolume");
          return { percent: v < 0 ? null : Math.round(v * 100) };
        };
        result =
          args.percent === undefined
            ? await read()
            : await waitFor(
                read,
                (x) => x.percent !== null && Math.abs(x.percent - args.percent) <= 1,
                "Volume was requested but not confirmed.",
              );
        break;
      }
      case "shuffle":
      case "repeat": {
        if (args.mode === undefined) {
          result = await status();
          break;
        }
        const value =
          operation === "shuffle"
            ? args.mode === "on"
            : { off: 0, context: 1, track: 2 }[args.mode];
        await call("PlayerAPI", operation === "shuffle" ? "setShuffle" : "setRepeat", [value]);
        result = await waitFor(
          status,
          (s) => (operation === "shuffle" ? s.shuffle === value : s.repeat === args.mode),
          "Playback option was not confirmed.",
        );
        break;
      }
      case "queue": {
        const q = await call("PlayerAPI", "getQueue");
        result = {
          current: item(q.current),
          queued: q.queued.map(item),
          nextUp: q.nextUp.slice(0, args.limit).map(item),
        };
        break;
      }
      case "queue-add": {
        const tracks = uris(args.uris).map((uri) => ({ uri }));
        const before = await call("PlayerAPI", "getQueue");
        const counts = (items) =>
          items.reduce(
            (values, item) => ((values[item.uri] = (values[item.uri] ?? 0) + 1), values),
            {},
          );
        const previous = counts(before.queued),
          added = counts(tracks);
        await call("PlayerAPI", "addToQueue", [tracks]);
        result = await waitFor(
          () => call("PlayerAPI", "getQueue"),
          (q) => {
            const observed = counts(q.queued);
            return Object.entries(added).every(
              ([uri, count]) => (observed[uri] ?? 0) >= (previous[uri] ?? 0) + count,
            );
          },
          "Queue addition was not confirmed.",
        );
        result = { queued: result.queued.map(item) };
        break;
      }
      case "queue-remove":
      case "queue-move": {
        const q = await call("PlayerAPI", "getQueue");
        const selected = [...q.queued, ...q.nextUp].find((i) => i.uid === args.uid);
        if (!selected) fail("NOT_FOUND", "Queue UID not found. Read queue to obtain current UIDs.");
        if (operation === "queue-remove") {
          await call("PlayerAPI", "removeFromQueue", [[{ uri: selected.uri, uid: selected.uid }]]);
          const changed = await waitFor(
            () => call("PlayerAPI", "getQueue"),
            (q) => ![...q.queued, ...q.nextUp].some((i) => i.uid === args.uid),
            "Queue removal was not confirmed.",
          );
          result = { queued: changed.queued.map(item) };
        } else {
          const target = q.queued[args.index];
          if (!target) fail("INVALID_ARGUMENT", "Target index is outside the explicit queue.");
          const from = q.queued.findIndex((i) => i.uid === selected.uid);
          if (from !== args.index)
            await call("PlayerAPI", "reorderQueue", [
              [{ uri: selected.uri, uid: selected.uid }],
              { [from < args.index ? "after" : "before"]: { uri: target.uri, uid: target.uid } },
            ]);
          const changed = await waitFor(
            () => call("PlayerAPI", "getQueue"),
            (q) => q.queued[args.index]?.uid === args.uid,
            "Queue order was not confirmed.",
          );
          result = { queued: changed.queued.map(item) };
        }
        break;
      }
      case "queue-clear": {
        await call("PlayerAPI", "clearQueue");
        await waitFor(
          () => call("PlayerAPI", "getQueue"),
          (q) => q.queued.length === 0,
          "Queue clear was not confirmed.",
        );
        result = { queued: [] };
        break;
      }
      case "library":
        result = page(
          await call("LibraryAPI", "getContents", [
            {
              offset: args.offset,
              limit: args.limit,
              ...(args.filter
                ? { filters: [{ playlist: "2", show: "3", album: "0", artist: "1" }[args.filter]] }
                : {}),
              ...(args.query ? { textFilter: args.query } : {}),
            },
          ]),
        );
        break;
      case "liked":
        result = page(
          await call("LibraryAPI", "getTracks", [{ offset: args.offset, limit: args.limit }]),
        );
        break;
      case "save":
      case "unsave":
      case "contains": {
        const selected = uris(args.uris);
        if (operation !== "contains")
          await call("LibraryAPI", operation === "save" ? "add" : "remove", [{ uris: selected }]);
        const read = async () =>
          await Promise.all(
            selected.map(async (input) => {
              const values = input.startsWith("spotify:playlist:")
                ? await call("RootlistAPI", "contains", [[input]])
                : await call("LibraryAPI", "contains", [input]);
              return values[0];
            }),
          );
        const values =
          operation === "contains"
            ? await read()
            : await waitFor(
                read,
                (v) => v.every((b) => b === (operation === "save")),
                "Library change was not confirmed.",
              );
        result = selected.map((uri, i) => ({ uri, saved: values[i] }));
        break;
      }
      case "playlists": {
        const root = await call("RootlistAPI", "getContents");
        const flatten = (items, parent = null) =>
          items.flatMap((i) =>
            i.type === "folder"
              ? [{ ...item(i), folder: parent }, ...flatten(i.items, i.uri)]
              : [{ ...item(i), folder: parent }],
          );
        result = { items: flatten(root.items), total: root.totalItemCount };
        break;
      }
      case "playlist":
        result = await playlist(args.uri, args.offset, args.limit);
        break;
      case "playlist-create": {
        const created = await call("RootlistAPI", "createPlaylist", [args.name, { after: "end" }]);
        if (!created) fail("ACTION_FAILED", "Spotify did not create the playlist.");
        try {
          // Rootlist creation completes before the permissions service is ready.
          // Its public setter discards the status (a new playlist can return 500).
          // Wait at the native response boundary, then check the actual write.
          const permissions = api("PlaylistPermissionsAPI");
          if (!permissions._client?.getMembers || !permissions._client?.setBasePermission)
            fail("UNSUPPORTED", "Playlist permission transport is unavailable.");
          await waitFor(
            () => permissions._client.getMembers({ uri: created, limit: { value: 0 } }),
            (r) => r.status?.statusCode === 200,
            "Created playlist is not ready in the permissions service.",
          );
          await call("RootlistAPI", "setPublishedState", [created, false]);
          // BLOCKED=1 in Spotify's shipped PlaylistPermissionLevel protobuf enum.
          const changed = await permissions._client.setBasePermission({
            uris: [created],
            request: { permissionLevel: 1, timeoutMs: 1000 },
          });
          if (changed.status?.statusCode !== 200)
            fail("ACTION_FAILED", "Spotify rejected the private playlist setting.", {
              status: changed.status,
            });
          await waitFor(
            () => permissions.getBasePermission(created),
            (v) => v === "BLOCKED",
            "Playlist privacy was requested but not confirmed.",
          );
          if (args.description)
            await call("PlaylistAPI", "updateDetails", [
              created,
              { description: args.description },
            ]);
          result = await playlist(created, 0, 0);
          result.private = true;
        } catch (error) {
          error.details = { ...error.details, createdUri: created };
          throw error;
        }
        break;
      }
      case "playlist-update": {
        const details = {};
        if (args.name !== undefined) details.name = args.name;
        if (args.description !== undefined) details.description = args.description;
        if (!Object.keys(details).length)
          fail("INVALID_ARGUMENT", "Provide --name or --description.");
        await call("PlaylistAPI", "updateDetails", [uri(args.uri), details]);
        result = await waitFor(
          () => playlist(args.uri, 0, 0),
          (p) => Object.entries(details).every(([key, value]) => p[key] === value),
          "Playlist details were not confirmed.",
        );
        break;
      }
      case "playlist-add": {
        const selected = uris(args.uris),
          target = uri(args.uri);
        const before = await call("PlaylistAPI", "getMetadata", [target]);
        await call("PlaylistAPI", "add", [target, selected, { after: "end" }]);
        await waitFor(
          () => call("PlaylistAPI", "getMetadata", [target]),
          (m) => m.totalLength >= before.totalLength + selected.length,
          "Playlist addition was not confirmed.",
        );
        result = { uri: target, added: selected };
        break;
      }
      case "playlist-remove":
      case "playlist-move": {
        const target = uri(args.uri);
        const found = await findRow(target, args.uid);
        if (!found)
          fail("NOT_FOUND", "Playlist row UID not found. Read playlist to obtain current UIDs.");
        const selected = found.row;
        if (operation === "playlist-remove") {
          await call("PlaylistAPI", "remove", [target, [{ uid: selected.uid, uri: selected.uri }]]);
          await waitFor(
            () => findRow(target, args.uid),
            (row) => row === null,
            "Playlist removal was not confirmed.",
          );
        } else {
          const anchor = (
            await call("PlaylistAPI", "getContents", [target, { offset: args.index, limit: 1 }])
          ).items[0];
          if (!anchor) fail("INVALID_ARGUMENT", "Target index is outside this playlist.");
          const from = found.index;
          if (from !== args.index)
            await call("PlaylistAPI", "move", [
              target,
              [{ uid: selected.uid, uri: selected.uri }],
              { [from < args.index ? "after" : "before"]: { uid: anchor.uid, uri: anchor.uri } },
            ]);
          await waitFor(
            () => call("PlaylistAPI", "getContents", [target, { offset: args.index, limit: 1 }]),
            (p) => p.items[0]?.uid === args.uid,
            "Playlist order was not confirmed.",
          );
        }
        result = {
          uri: target,
          uid: args.uid,
          ...(args.index !== undefined ? { index: args.index } : {}),
        };
        break;
      }
      case "playlist-follow":
      case "playlist-unfollow": {
        const target = uri(args.uri);
        await call(
          "RootlistAPI",
          operation === "playlist-follow" ? "add" : "remove",
          operation === "playlist-follow" ? [[target], { after: "end" }] : [[{ uri: target }]],
        );
        const observed = await waitFor(
          () => call("RootlistAPI", "contains", [[target]]),
          (values) => values[0] === (operation === "playlist-follow"),
          "Playlist follow state was not confirmed.",
        );
        result = { uri: target, followed: observed[0] };
        break;
      }
      case "folder-create":
        result = await call("RootlistAPI", "createFolder", [args.name, { after: "end" }]);
        break;
      case "folder-rename":
        await call("RootlistAPI", "renameFolder", [{ uri: uri(args.uri) }, args.name]);
        result = { uri: uri(args.uri), name: args.name };
        break;
      case "folder-move": {
        const selected = uri(args.uri),
          destination = args.folder === "root" ? null : uri(args.folder);
        if (destination && !/:folder:/.test(destination))
          fail("INVALID_ARGUMENT", "Destination must be a folder URI or root.");
        if (selected === destination)
          fail("INVALID_ARGUMENT", "An item cannot be moved into itself.");
        const find = (entries, wanted, parent = null) => {
          for (const entry of entries) {
            if (entry.uri === wanted) return { entry, parent };
            if (entry.items) {
              const nested = find(entry.items, wanted, entry.uri);
              if (nested) return nested;
            }
          }
          return null;
        };
        const root = await call("RootlistAPI", "getContents");
        const source = find(root.items, selected);
        if (!source) fail("NOT_FOUND", "Item is not in your playlist tree.");
        if (destination) {
          const folder = find(root.items, destination);
          if (!folder) fail("NOT_FOUND", "Destination folder was not found.");
          if (source.entry.items && find(source.entry.items, destination))
            fail("INVALID_ARGUMENT", "A folder cannot be moved inside its descendant.");
        }
        await call("RootlistAPI", "move", [
          [{ uri: selected }],
          destination ? { after: { uri: destination } } : { after: "end" },
        ]);
        await waitFor(
          () => call("RootlistAPI", "getContents"),
          (tree) => find(tree.items, selected)?.parent === destination,
          "Folder placement was not confirmed.",
        );
        result = { uri: selected, folder: destination };
        break;
      }
      case "devices":
        result = (await call("ConnectDevicesAPI", "getDevices")).map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          active: d.isActive,
          local: d.isLocal,
          available: !d.isDisabled,
          volume: Math.round(d.volume * 100),
        }));
        break;
      case "transfer": {
        const devices = await call("ConnectDevicesAPI", "getDevices");
        const matches = devices.filter((d) => d.id === args.device || d.name === args.device);
        if (matches.length !== 1)
          fail("NOT_FOUND", "Specify an exact device ID or unique device name from devices.");
        if (matches[0].isDisabled) fail("UNAVAILABLE", "Selected device is unavailable.");
        await call("ConnectTransferAPI", "transferPlayback", [
          matches[0].id,
          { interactionId: crypto.randomUUID() },
        ]);
        result = await waitFor(
          status,
          (s) => s.deviceId === matches[0].id,
          "Device transfer was not confirmed.",
        );
        break;
      }
      case "history": {
        const history = await call("PlayHistoryAPI", "getContents");
        result = {
          items: history.items.slice(args.offset, args.offset + args.limit).map(item),
          offset: args.offset,
          limit: args.limit,
          total: history.items.length,
        };
        break;
      }
      case "recent":
        result = (await call("RecentlyPlayedAPI", "getContexts")).map(item);
        break;
      case "settings":
      case "setting": {
        const settings = api("SettingsAPI");
        const groups = [
          "language",
          "quality",
          "autoPlay",
          "viewportZoom",
          "display",
          "contentPreferences",
          "social",
          "playback",
          "shuffle",
          "startupBehaviour",
          "hardwareAcceleration",
        ];
        const available = {};
        for (const group of groups) {
          const object = settings[group];
          if (!object) continue;
          if (typeof object.getValue === "function") available[group] = object;
          else
            for (const [key, value] of Object.entries(object))
              if (typeof value?.getValue === "function") available[`${group}.${key}`] = value;
        }
        if (operation === "settings")
          result = Object.fromEntries(
            await Promise.all(
              Object.entries(available).map(async ([k, v]) => {
                try {
                  return [
                    k,
                    {
                      value: await v.getValue(),
                      writable: typeof v.setValue === "function",
                      supported: true,
                    },
                  ];
                } catch (error) {
                  return [k, { supported: false, writable: false, reason: error.message }];
                }
              }),
            ),
          );
        else {
          const setting = available[args.key];
          if (!setting) fail("NOT_FOUND", "Unknown setting. Run settings to list available keys.");
          if (args.value !== undefined) {
            if (typeof setting.setValue !== "function")
              fail("UNSUPPORTED", "Setting is read-only.");
            const current = await setting.getValue();
            if (current !== null && typeof current !== typeof args.value)
              fail("INVALID_ARGUMENT", `Setting value must have type ${typeof current}.`);
            await setting.setValue(args.value);
            await waitFor(
              () => setting.getValue(),
              (v) => JSON.stringify(v) === JSON.stringify(args.value),
              "Setting change was not confirmed.",
            );
          }
          result = { key: args.key, value: await setting.getValue() };
        }
        break;
      }
      case "open":
        platform
          .getHistory()
          .push(
            args.uri === "liked"
              ? "/collection/tracks"
              : `/${uri(args.uri).split(":").slice(1).join("/")}`,
          );
        result = { path: platform.getHistory().location.pathname };
        break;
      case "queries":
        if (args.route) await loadRoute(args.route);
        result = [...queryDefinitions().values()]
          .filter((d) => d.operation === "query")
          .map((d) => ({ name: d.name }));
        break;
      case "query":
        if (args.route) await loadRoute(args.route);
        result = await query(args.name, args.variables);
        break;
      case "apis":
      case "api-call": {
        const services = [
          "PlayerAPI",
          "PlaylistAPI",
          "PlaylistPermissionsAPI",
          "RootlistAPI",
          "LibraryAPI",
          "ConnectAPI",
          "ConnectDevicesAPI",
          "ConnectTransferAPI",
          "PlaybackAPI",
          "EqualizerAPI",
          "OfflineAPI",
          "PrivateSessionAPI",
          "PlayHistoryAPI",
          "RecentlyPlayedAPI",
          "RecentsAPI",
          "LocalFilesAPI",
          "FollowAPI",
          "CollectionPlatformAPI",
          "UserAPI",
          "PlaylistMixingAPI",
          "AudioOutputDevicesAPI",
          "CurationAPI",
          "ShowAPI",
          "PlayabilityAPI",
          "ResumptionProgressAPI",
        ];
        const forbidden = new Set([
          "constructor",
          "logout",
          "getEvents",
          "removeAllDownloads",
          "removeCache",
        ]);
        const methods = (name) => {
          const object = api(name);
          return [
            ...new Set([
              ...Object.getOwnPropertyNames(Object.getPrototypeOf(object)),
              ...Object.keys(object),
            ]),
          ].filter(
            (k) => !k.startsWith("_") && !forbidden.has(k) && typeof object[k] === "function",
          );
        };
        if (operation === "apis") {
          const names = services.filter((name) =>
            [...registry._map.keys()].some((k) => k.description === name),
          );
          if (args.api && !names.includes(args.api))
            fail("UNSUPPORTED", "Service is not exposed. Run apis for available services.");
          result = (args.api ? [args.api] : names).map((name) => ({
            name,
            methods: methods(name),
          }));
          if (args.method) {
            if (!args.api || !methods(args.api).includes(args.method))
              fail("NOT_FOUND", "Specify an exposed --api and --method.");
            result = {
              api: args.api,
              method: args.method,
              implementation: api(args.api)[args.method].toString(),
            };
          }
        } else {
          if (!services.includes(args.api) || !methods(args.api).includes(args.method))
            fail("UNSUPPORTED", "API method is not exposed. Run apis for available methods.");
          result = await call(args.api, args.method, args.arguments);
        }
        break;
      }
      default:
        fail("UNKNOWN_COMMAND", `Unknown operation: ${operation}`);
    }
    return { ok: true, result: redact(result) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code ?? "SPOTIFY_ERROR",
        message: String(error.message ?? error),
        ...(error.details ? { details: redact(error.details) } : {}),
      },
    };
  }
}
