package com.koma.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Checks GitHub Releases, downloads the APK for this product flavor and keeps
 * it in private storage until the viewer approves the Android installer.
 */
final class UpdateManager {

  static final String DEFAULT_RELEASE_API =
      "https://api.github.com/repos/Braedennn/Koma-Stream/releases/latest";

  private static final long CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L;
  private static final long DEFER_MS = 24 * 60 * 60 * 1000L;
  private static final int CONNECT_TIMEOUT_MS = 15000;
  private static final int READ_TIMEOUT_MS = 60000;

  enum Kind { IDLE, CHECKING, DOWNLOADING, READY, FAILED, CHECK_FAILED, UP_TO_DATE }

  static final class State {
    final Kind kind;
    final String version;
    final String notes;
    final String error;
    final long downloaded;
    final long total;
    final File apk;

    State(Kind kind, String version, String notes, String error,
          long downloaded, long total, File apk) {
      this.kind = kind;
      this.version = version == null ? "" : version;
      this.notes = notes == null ? "" : notes;
      this.error = error == null ? "" : error;
      this.downloaded = downloaded;
      this.total = total;
      this.apk = apk;
    }

    static State idle() {
      return new State(Kind.IDLE, "", "", "", 0, 0, null);
    }

    boolean actionable() {
      return kind == Kind.DOWNLOADING || kind == Kind.READY
          || (kind == Kind.FAILED && !version.isEmpty());
    }
  }

  interface Listener {
    void onUpdateState(State state);
  }

  /** Release metadata that passed the check, ready for the download phase. */
  private static final class ReleasePlan {
    final String version;
    final String notes;
    final UpdateAsset asset;
    final String flavor;

    ReleasePlan(String version, String notes, UpdateAsset asset, String flavor) {
      this.version = version;
      this.notes = notes;
      this.asset = asset;
      this.flavor = flavor;
    }
  }

  private final Context context;
  private final File updateDir;
  private final SharedPreferences preferences;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
  private final String releaseApi;

  private volatile State state = State.idle();
  private Listener listener;
  private boolean running;
  private boolean forcePrompt;
  private boolean closed;
  private volatile HttpURLConnection activeConnection;

  UpdateManager(Context context, String releaseApiOverride) {
    this.context = context.getApplicationContext();
    this.updateDir = new File(this.context.getFilesDir(), "updates");
    this.updateDir.mkdirs();
    this.preferences = this.context.getSharedPreferences("koma-updates", Context.MODE_PRIVATE);
    this.releaseApi = releaseApiOverride == null || releaseApiOverride.trim().isEmpty()
        ? DEFAULT_RELEASE_API : releaseApiOverride.trim();
  }

  void setListener(Listener listener) {
    synchronized (this) {
      if (closed) {
        this.listener = null;
        return;
      }
      this.listener = listener;
    }
  }

  State state() {
    return state;
  }

  String installedVersion() {
    return UpdateVersion.canonical(BuildConfig.VERSION_NAME);
  }

  void check(boolean force) {
    synchronized (this) {
      if (closed || running) return;
      long now = System.currentTimeMillis();
      if (!force && now - preferences.getLong("lastCheck", 0L) < CHECK_INTERVAL_MS) return;
      running = true;
    }
    State previous = state;
    publish(new State(Kind.CHECKING, previous.version, previous.notes, "", 0, 0, null));
    try {
      worker.execute(() -> {
        try {
          ReleasePlan plan;
          try {
            plan = checkRelease();
          } catch (Exception e) {
            MainActivity.traceThrowable(context, "update check failed", e);
            State current = state;
            publish(new State(Kind.CHECK_FAILED, current.version, current.notes,
                checkMessage(e), 0, 0, null));
            return;
          }

          // The release metadata was checked successfully. A later download
          // failure must not make the app ask GitHub again on every launch.
          preferences.edit().putLong("lastCheck", System.currentTimeMillis()).apply();
          if (plan == null) return;

          try {
            prepareAndDownload(plan);
          } catch (Exception e) {
            MainActivity.traceThrowable(context, "update download failed", e);
            publish(new State(Kind.FAILED, plan.version, plan.notes,
                downloadMessage(e), 0, 0, null));
          }
        } finally {
          synchronized (UpdateManager.this) {
            running = false;
          }
        }
      });
    } catch (RejectedExecutionException ignored) {
      synchronized (this) {
        running = false;
      }
    }
  }

  /** Shows the cached update, or starts a check when there is nothing cached yet. */
  void requestPrompt() {
    synchronized (this) {
      if (closed) return;
      forcePrompt = true;
    }
    State current = state;
    if (current.kind == Kind.READY || current.kind == Kind.DOWNLOADING) {
      publish(current);
    } else {
      check(true);
    }
  }

  /** Keeps the downloaded APK but does not ask again about this release for a day. */
  void defer() {
    synchronized (this) {
      if (closed) return;
    }
    State current = state;
    if (current.version.isEmpty()) return;
    preferences.edit()
        .putString("deferredVersion", current.version)
        .putLong("deferredAt", System.currentTimeMillis())
        .apply();
  }

  void retry() {
    synchronized (this) {
      if (closed) return;
      forcePrompt = true;
      preferences.edit().remove("lastCheck").apply();
    }
    check(true);
  }

  /** True when a ready update should open its confirmation screen automatically. */
  boolean shouldShowPrompt() {
    synchronized (this) {
      if (forcePrompt) {
        forcePrompt = false;
        return true;
      }
      String version = state.version;
      String deferred = preferences.getString("deferredVersion", "");
      long deferredAt = preferences.getLong("deferredAt", 0L);
      return !version.equals(deferred)
          || System.currentTimeMillis() - deferredAt >= DEFER_MS;
    }
  }

  void shutdown() {
    final HttpURLConnection connection;
    synchronized (this) {
      if (closed) return;
      closed = true;
      listener = null;
      connection = activeConnection;
    }
    if (connection != null) connection.disconnect();
    worker.shutdownNow();
  }

  /** Fetches and validates release metadata. The APK is downloaded separately. */
  private ReleasePlan checkRelease() throws Exception {
    String json = fetch(releaseApi);
    GitHubRelease release = GitHubRelease.fromJson(json);
    String installed = installedVersion();
    if (!UpdateVersion.isNewer(release.version, installed)) {
      evictStaleCache(null);
      publish(new State(Kind.UP_TO_DATE, release.version, release.notes, "", 0, 0, null));
      return null;
    }

    String flavor = BuildConfig.IS_TV ? "tv" : "phone";
    UpdateAsset asset = UpdateAssetSelector.select(release.assets, flavor, release.version);
    if (asset == null) {
      // A desktop-only release is still a valid release; this flavor simply has
      // nothing to install yet.
      evictStaleCache(null);
      publish(new State(Kind.UP_TO_DATE, release.version, release.notes, "", 0, 0, null));
      return null;
    }
    if (!asset.hasSha256()) {
      throw new IllegalStateException("The release APK is missing a valid SHA-256 checksum.");
    }

    String deferred = preferences.getString("deferredVersion", "");
    if (!release.version.equals(deferred)) {
      preferences.edit().remove("deferredVersion").remove("deferredAt").apply();
    }
    return new ReleasePlan(release.version, release.notes, asset, flavor);
  }

  /** Uses a verified cached APK or downloads and validates a fresh one. */
  private void prepareAndDownload(ReleasePlan plan) throws Exception {
    File cached = cachedFile(plan.version, plan.flavor);
    evictStaleCache(cached);
    if (cached.isFile() && matchesAsset(cached, plan.asset)
        && ApkValidator.validate(context, cached, context.getPackageName(), plan.version).valid) {
      publish(new State(Kind.READY, plan.version, plan.notes, "", 0, 0, cached));
      return;
    }
    if (cached.exists() && !cached.delete()) {
      throw new IllegalStateException("The old update could not be replaced.");
    }

    publish(new State(Kind.DOWNLOADING, plan.version, plan.notes, "", 0, plan.asset.size, null));
    download(plan.asset, plan.version, plan.notes, plan.flavor);
  }

  private File cachedFile(String version, String flavor) {
    String safe = version.replaceAll("[^0-9A-Za-z._-]", "_");
    return new File(updateDir, "Koma-" + safe + "-" + flavor + ".apk");
  }

  /** Keeps only the APK for the release being installed; old downloads are dead weight. */
  private void evictStaleCache(File keep) {
    File[] files = updateDir.listFiles();
    if (files == null) return;
    for (File file : files) {
      if (!file.isFile() || (keep != null && file.equals(keep))) continue;
      file.delete();
    }
  }

  private void download(UpdateAsset asset, String version, String notes, String flavor) throws Exception {
    File finalFile = cachedFile(version, flavor);
    File part = new File(finalFile.getPath() + ".part");
    if (part.exists() && !part.delete()) {
      throw new IllegalStateException("The incomplete update could not be removed.");
    }

    HttpURLConnection connection = null;
    InputStream input = null;
    FileOutputStream output = null;
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    long written = 0;
    long announced = 0;
    try {
      connection = open(asset.url);
      int status = connection.getResponseCode();
      if (status != HttpURLConnection.HTTP_OK) {
        throw new IllegalStateException("The update server returned HTTP " + status + ".");
      }
      long contentLength = connection.getContentLengthLong();
      long total = asset.size > 0 ? asset.size : contentLength;
      input = new BufferedInputStream(connection.getInputStream(), 64 * 1024);
      output = new FileOutputStream(part);
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (closed || Thread.currentThread().isInterrupted()) {
          throw new IllegalStateException("The update was cancelled.");
        }
        output.write(buffer, 0, count);
        digest.update(buffer, 0, count);
        written += count;
        if (written - announced >= 512 * 1024) {
          announced = written;
          publish(new State(Kind.DOWNLOADING, version, notes, "", written, total, null));
        }
      }
      output.flush();
      output.close();
      output = null;

      if (asset.size > 0 && written != asset.size) {
        throw new IllegalStateException("The downloaded update was incomplete.");
      }
      String expected = asset.sha256.toLowerCase(Locale.US);
      String actual = hex(digest.digest());
      if (!actual.equals(expected)) {
        throw new IllegalStateException("The downloaded update failed its SHA-256 check.");
      }
      if (!part.renameTo(finalFile)) {
        throw new IllegalStateException("The downloaded update could not be saved.");
      }
    } catch (Exception e) {
      if (part.exists()) part.delete();
      throw e;
    } finally {
      close(input);
      close(output);
      closeConnection(connection);
    }

    if (part.exists()) part.delete();
    ApkValidator.Result validation =
        ApkValidator.validate(context, finalFile, context.getPackageName(), version);
    if (!validation.valid) {
      finalFile.delete();
      throw new IllegalStateException(validation.message);
    }
    publish(new State(Kind.READY, version, notes, "", written, written, finalFile));
  }

  private boolean matchesAsset(File file, UpdateAsset asset) {
    if (!file.isFile() || !asset.hasSha256()) return false;
    if (asset.size > 0 && file.length() != asset.size) return false;
    String expected = asset.sha256.toLowerCase(Locale.US);
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[64 * 1024];
      try (InputStream input = new FileInputStream(file)) {
        int count;
        while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
      }
      return hex(digest.digest()).equals(expected);
    } catch (Exception e) {
      return false;
    }
  }

  private String fetch(String endpoint) throws Exception {
    HttpURLConnection connection = open(endpoint);
    try {
      int status = connection.getResponseCode();
      if (status != HttpURLConnection.HTTP_OK) {
        throw new IllegalStateException("GitHub returned HTTP " + status + ".");
      }
      try (InputStream input = new BufferedInputStream(connection.getInputStream())) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
        return bytes.toString("UTF-8");
      }
    } finally {
      closeConnection(connection);
    }
  }

  private HttpURLConnection open(String url) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
    connection.setReadTimeout(READ_TIMEOUT_MS);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("Accept", "application/vnd.github+json");
    connection.setRequestProperty("User-Agent", "Koma-Android/" + BuildConfig.VERSION_NAME);
    synchronized (this) {
      if (closed) {
        connection.disconnect();
        throw new IllegalStateException("The updater has already stopped.");
      }
      activeConnection = connection;
    }
    return connection;
  }

  private void closeConnection(HttpURLConnection connection) {
    synchronized (this) {
      if (activeConnection == connection) activeConnection = null;
    }
    if (connection != null) connection.disconnect();
  }

  private void publish(State next) {
    final Listener current;
    synchronized (this) {
      if (closed) return;
      state = next;
      current = listener;
    }
    if (current == null) return;
    main.post(() -> {
      synchronized (UpdateManager.this) {
        if (closed || listener != current) return;
      }
      current.onUpdateState(next);
    });
  }

  JSONObject statusJson() throws Exception {
    State current = state;
    JSONObject result = new JSONObject();
    result.put("current", installedVersion());
    result.put("latest", current.version.isEmpty() ? installedVersion() : current.version);
    result.put("outdated", current.actionable());
    result.put("state", current.kind.name().toLowerCase(Locale.US));
    result.put("checking", current.kind == Kind.CHECKING || current.kind == Kind.DOWNLOADING);
    result.put("error", current.error);
    return result;
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
    return result.toString();
  }

  private static String checkMessage(Exception error) {
    String message = error.getMessage();
    return message == null || message.trim().isEmpty()
        ? "The update could not be checked." : message;
  }

  private static String downloadMessage(Exception error) {
    String message = error.getMessage();
    return message == null || message.trim().isEmpty()
        ? "The update could not be downloaded." : message;
  }

  private static void close(Object stream) {
    if (stream instanceof InputStream) {
      try { ((InputStream) stream).close(); } catch (Exception ignored) { }
    } else if (stream instanceof FileOutputStream) {
      try { ((FileOutputStream) stream).close(); } catch (Exception ignored) { }
    }
  }
}
