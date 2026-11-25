package com.koma.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Koma on Android: start the Node runtime (which hosts the site and its
 * streaming servers on the loopback), wait for the site to answer, and show it
 * in a WebView. Everything the page does afterwards is the same as in a
 * browser — no special bridge for the core features.
 */
public class MainActivity extends Activity {

  private static WifiManager.MulticastLock roomMulticastLock;

  private WebView webView;
  private FrameLayout rootLayout;
  private String pendingAuthCallback;
  private OAuthCallbackServer oauthCallbackServer;
  private VideoChromeClient videoChromeClient;
  private UpdateManager updateManager;
  private UpdatePrompt updatePrompt;
  private View customView;
  private WebChromeClient.CustomViewCallback customViewCallback;
  private volatile boolean textEntryRequested;
  private boolean serversStarted;
  private boolean startupSplash = true;

  /* The remote's keys go to the page, not to the WebView: the page knows
     what has the focus and what the pad should do with it. */
  private final Handler ui = new Handler(Looper.getMainLooper());
  private Runnable holdKey = null;
  private long lastPadKey = 0;         // when the pad was last passed on
  private static final long REPEAT_MS = 70;  // how fast a held pad walks

  /**
   * The app's own diagnosis trail: every stage lands in a file the user can
   * hand over, because "it just closes" with no error is not diagnosable from
   * the outside. Two copies - private storage and the app's external dir -
   * so either is reachable depending on what tools are available.
   */
  static void trace(Context c, String line) {
    String stamp = new java.text.SimpleDateFormat("MM-dd HH:mm:ss.SSS", java.util.Locale.US)
        .format(new java.util.Date());
    String entry = stamp + " " + line + "\n";
    try {
      OutputStream out = new FileOutputStream(new File(c.getFilesDir(), "koma-log.txt"), true);
      out.write(entry.getBytes());
      out.close();
    } catch (Exception ignored) { }
    try {
      File ext = c.getExternalFilesDir(null);
      if (ext != null) {
        OutputStream out = new FileOutputStream(new File(ext, "koma-log.txt"), true);
        out.write(entry.getBytes());
        out.close();
      }
    } catch (Exception ignored) { }
    Log.d("KomaApp", line);
  }

  static void traceThrowable(Context c, String what, Throwable e) {
    java.io.StringWriter sw = new java.io.StringWriter();
    e.printStackTrace(new java.io.PrintWriter(sw));
    trace(c, what + ": " + sw);
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Uri initialIntent = getIntent() == null ? null : getIntent().getData();
    if (initialIntent != null && BuildConfig.APPLICATION_ID.equals(initialIntent.getScheme())) {
      pendingAuthCallback = initialIntent.toString();
    }

    // Anything that kills the process writes its trace first.
    final Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
      traceThrowable(this, "uncaught exception on " + t.getName(), e);
      if (prior != null) prior.uncaughtException(t, e);
    });
    trace(this, "app opening, build " + BuildConfig.VERSION_NAME);

    // Edge to edge: the app draws under the system bars, so there are no
    // black bands at the notch or above the gesture pill - the page's own
    // background and safe-area padding own those regions.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      getWindow().setDecorFitsSystemWindows(false);
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
    getWindow().setStatusBarColor(Color.TRANSPARENT);
    getWindow().setNavigationBarColor(Color.TRANSPARENT);
    if (!BuildConfig.IS_TV && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Android otherwise paints its own opaque scrim behind gesture navigation,
      // recreating the black band even though the navigation bar is transparent.
      getWindow().setStatusBarContrastEnforced(false);
      getWindow().setNavigationBarContrastEnforced(false);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams lp = getWindow().getAttributes();
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      getWindow().setAttributes(lp);
    }

    // A television has no status bar and no navigation bar: the picture is
    // the page, and every row the bars take is a row the video does not get.
    // The bars come back by a swipe, the way they do on a set-top box.
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    // The device's media volume governs the app: the volume keys change the
    // stream the WebView plays through, so nothing ever plays at a level the
    // user did not set.
    setVolumeControlStream(AudioManager.STREAM_MUSIC);

    rootLayout = new FrameLayout(this);
    rootLayout.setBackgroundColor(Color.BLACK);
    webView = new WebView(this);
    rootLayout.addView(webView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(rootLayout);

    String updateApi = BuildConfig.DEBUG
        ? getIntent().getStringExtra("update_api_url") : null;
    updateManager = new UpdateManager(this, updateApi);
    updatePrompt = new UpdatePrompt(this, new UpdatePrompt.Callbacks() {
      @Override
      public void onUpdateNow(File apk, String version) {
        installUpdate(apk, version);
      }

      @Override
      public void onLater() {
        updateManager.defer();
      }

      @Override
      public void onRetry() {
        updateManager.retry();
      }
    });
    updateManager.setListener(state -> runOnUiThread(() -> onUpdateState(state)));
    updateManager.check(false);

    // A television has no status bar and no navigation bar: the picture is
    // the page, and every row the bars take is a row the video does not get.
    // The bars come back by a swipe, the way they do on a set-top box.
    if (BuildConfig.IS_TV) applyImmersive(true);

    WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect while testing
    WebSettings s = webView.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);            // the library, progress, preferences
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setUseWideViewPort(true);
    // Overview mode shrinks the page to fit content that is wider than the
    // screen and then lets it be panned around. The layout is the app's own
    // and always fits, so the page stays at the device's width.
    s.setLoadWithOverviewMode(false);
    // Pinch and double-tap zoom are desktop-browser leftovers here: the layout
    // is the app's own, and an accidental pinch left the user panning a
    // half-zoomed page around.
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    videoChromeClient = new VideoChromeClient();
    webView.setWebViewClient(new AccountWebViewClient());
    webView.setWebChromeClient(videoChromeClient);
    // The page reads the app's version through this - the footer then says
    // "Koma 1.7.17 - Up to date" instead of presenting the app as a web page.
    webView.addJavascriptInterface(new KomaBridge(), "KomaAndroid");
    // The desktop splash stays visible while the embedded servers boot instead
    // of leaving the viewer looking at an empty black window. Its load callback
    // starts Node, so even the runtime libraries load after the splash appears.
    webView.loadUrl("file:///android_asset/splash.html");
    trace(this, "webview ready");

    acquireRoomMulticastLock();
  }

  /** Hand the TV's application key to Node without exposing it to the page. */
  private void prepareOpenSubtitlesConfig() {
    File config = new File(getFilesDir(), "opensubtitles.json");
    try {
      if (BuildConfig.OPENSUBTITLES_API_KEY.isEmpty()) {
        if (config.exists()) config.delete();
        return;
      }
      String json = new JSONObject().put("apiKey", BuildConfig.OPENSUBTITLES_API_KEY).toString();
      FileOutputStream out = new FileOutputStream(config, false);
      out.write(json.getBytes("UTF-8"));
      out.close();
    } catch (Exception error) {
      traceThrowable(this, "could not prepare OpenSubtitles", error);
    }
  }

  /**
   * Start the Node runtime that hosts Koma and the AniVault streaming API.
   */
  private void startServers() {
    prepareOpenSubtitlesConfig();
    splashStatus("Starting Koma…");
    try {
      trace(this, "starting node runtime");
      // The port the site ends up on belongs to this run: the old note is
      // cleared so the app waits for the new one.
      try { new File(getFilesDir(), "koma-site.port").delete(); } catch (Exception ignored) { }
      new RNNodeJsMobileModule(getApplicationContext()).startNodeProject("main.js");
      trace(this, "node start requested, waiting for the site");
    } catch (Throwable t) {
      traceThrowable(this, "node start threw", t);
      throw t instanceof RuntimeException ? (RuntimeException) t : new RuntimeException(t);
    }
    waitForSite();
  }

  /** Android filters multicast packets from Wi-Fi unless the app holds this lock. */
  private void acquireRoomMulticastLock() {
    try {
      WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      if (wifi == null) return;
      roomMulticastLock = wifi.createMulticastLock("koma-room");
      roomMulticastLock.setReferenceCounted(false);
      roomMulticastLock.acquire();
    } catch (Exception ignored) { }
  }

  /** Update the shared desktop/Android splash while the site is still booting. */
  private void splashStatus(final String text) {
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        if (webView == null) return;
        String script = "if (typeof window.setStatus === 'function') window.setStatus("
            + JSONObject.quote(text) + ");";
        webView.evaluateJavascript(script, null);
      }
    });
  }

  /** Poll the site until the servers answer, then load it. */
  private void waitForSite() {
    new Thread(new Runnable() {
      @Override
      public void run() {
        for (int i = 0; i < 120; i++) { // a minute: the first asset copy takes a moment
          int port = sitePort();
          if (port > 0 && pingSite(port)) {
            final int p = port;
            runOnUiThread(new Runnable() {
              @Override
              public void run() {
                if (webView == null) return;
                trace(MainActivity.this, "loading the site in the webview");
                splashStatus("Almost ready…");
                // The television app opens the site in television mode, so the
                // layout and the remote's navigation are the television's.
                String callback = pendingAuthCallback;
                pendingAuthCallback = null;
                if (callback != null) handleAuthCallback(callback);
                else webView.loadUrl("http://127.0.0.1:" + p + (BuildConfig.IS_TV ? "/?tv=1" : "/"));
              }
            });
            return;
          }
          try { Thread.sleep(500); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
          }
        }
        trace(MainActivity.this, "the site never answered after a minute");
        splashStatus("Koma didn't start. Check the app's diagnostic log.");
      }
    }).start();
  }

  /**
   * The port the site took. The phone app and the television app can be
   * installed side by side, so they cannot both have 4180: the Node runtime
   * picks the first free pair and writes the port down here.
   */
  private int sitePort() {
    File f = new File(getFilesDir(), "koma-site.port");
    if (!f.exists()) return 0;
    try (BufferedReader r = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f)))) {
      String line = r.readLine();
      int p = Integer.parseInt(line.trim());
      return p > 0 ? p : 0;
    } catch (Exception e) {
      return 0;
    }
  }

  private boolean pingSite(int port) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/koma").openConnection();
      c.setConnectTimeout(1500);
      c.setReadTimeout(1500);
      try {
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()));
        String body = r.readLine();
        r.close();
        boolean ok = body != null && body.contains("\"koma\"");
        if (ok) trace(this, "site answered on " + port + ": " + body);
        return ok;
      } finally {
        c.disconnect();
      }
    } catch (Exception e) {
      return false;
    }
  }

  /** Shows or refreshes the native update confirmation when there is one to show. */
  private void onUpdateState(UpdateManager.State state) {
    if (activityGone() || updatePrompt == null) return;
    if (state.kind == UpdateManager.Kind.UP_TO_DATE) {
      if (updatePrompt.isShowing()) updatePrompt.dismiss();
      return;
    }
    if (updatePrompt.isShowing()) {
      updatePrompt.show(state);
      return;
    }
    if (!state.actionable()) return;
    if (!updateManager.shouldShowPrompt()) return;
    updatePrompt.show(state);
  }

  private boolean activityGone() {
    return isFinishing() || isDestroyed();
  }

  /** Validates once more, then hands the APK to Android's own installer. */
  private void installUpdate(File apk, String version) {
    if (activityGone()) return;
    UpdateInstaller.Result result = UpdateInstaller.install(this, apk, version);
    if (result.needsInstallPermission) {
      updatePrompt.setPermissionMessage(result.error);
    } else if (!result.error.isEmpty()) {
      updatePrompt.setInstallError(result.error);
    } else {
      updatePrompt.dismissAfterInstall();
    }
  }

  /** The version, read by the page: the footer reports the app, not "web". */
  private class KomaBridge {
    @JavascriptInterface
    public String version() {
      try {
        return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
      } catch (Exception e) {
        return "";
      }
    }

    /** The installed version and the native updater's current state. */
    @JavascriptInterface
    public String updateStatus() {
      try {
        return updateManager.statusJson().toString();
      } catch (Exception e) {
        return "{\"current\":\"\",\"latest\":\"\",\"outdated\":false,\"state\":\"idle\"}";
      }
    }

    /** Ask GitHub for a new release now, even when the periodic check is quiet. */
    @JavascriptInterface
    public boolean updateCheck() {
      if (updateManager == null) return false;
      updateManager.check(true);
      return true;
    }

    /** Bring back a downloaded update after the viewer chose Later. */
    @JavascriptInterface
    public boolean updateShow() {
      if (updateManager == null) return false;
      updateManager.requestPrompt();
      return true;
    }

    /** Dismiss the native update card without installing anything. */
    @JavascriptInterface
    public boolean updateCancel() {
      runOnUiThread(() -> {
        if (activityGone()) return;
        if (updateManager != null) updateManager.defer();
        if (updatePrompt != null) updatePrompt.dismissAsLater();
      });
      return true;
    }

    /** Is this the television build? The page asks before it draws. */
    @JavascriptInterface
    public boolean isTv() {
      return BuildConfig.IS_TV;
    }

    /**
     * Give the video the whole screen: the system bars go away and the page
     * gets every pixel of the display.
     */
    @JavascriptInterface
    public void immersive(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          applyImmersive(on);
        }
      });
    }

    /**
     * Leave the app. The remote's back button asks for this when the page
     * has nowhere left to go back to.
     */
    @JavascriptInterface
    public void exit() {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          finish();
        }
      });
    }

    /**
     * Show or put away the soft keyboard.
     *
     * A television has no keyboard of its own, so the search screen asks the
     * system for one when the field takes the focus, and puts it away when
     * the search is over.
     */
    @JavascriptInterface
    public void setTextEntry(final boolean on) {
      textEntryRequested = on;
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null) return;
            if (on) {
              // A focused HTML field supplies the input connection, but TV
              // builds of Gboard can ignore an implicit request made while a
              // dialog opens. Restart that connection and explicitly show the
              // IME; the same request also works when the field is clicked
              // after the keyboard has been dismissed.
              // Re-focusing an already focused WebView makes Chromium move
              // the page focus away from the HTML input. Keep the text editor
              // intact; only recover native focus when another view owns it.
              if (!webView.hasFocus()) webView.requestFocus();
              imm.restartInput(webView);
              boolean shown = imm.showSoftInput(webView, InputMethodManager.SHOW_FORCED);
              if (!shown) Log.w("Koma", "the television keyboard could not be shown");
            } else {
              imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
            }
          } catch (Exception e) {
            Log.w("Koma", "text entry: " + e);
          }
        }
      });
    }
  }

  /** Hide or show the system bars around the app. */
  private void applyImmersive(boolean on) {
    // A television has no bars of its own: they stay out of the way for
    // good, whether the picture is full screen or not.
    if (BuildConfig.IS_TV && !on) return;
    View decor = getWindow().getDecorView();
    if (on) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
          c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
          c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
      } else {
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
      }
    } else {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
      } else {
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
      }
    }
  }

  /* ---------- the remote ---------- */

  /** The name the page knows a key by, or null if the key is not ours. */
  private String remoteKey(int keyCode, KeyEvent event) {
    switch (keyCode) {
      case KeyEvent.KEYCODE_DPAD_UP: return "up";
      case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
      case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
      case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
      case KeyEvent.KEYCODE_DPAD_CENTER:
      case KeyEvent.KEYCODE_ENTER:
      case KeyEvent.KEYCODE_NUMPAD_ENTER:
      // The A button of a controller is the same thing as the middle button
      // of a remote.
      case KeyEvent.KEYCODE_BUTTON_A: return "center";
      case KeyEvent.KEYCODE_BACK: return "back";
      case KeyEvent.KEYCODE_MENU: return "menu";
      case KeyEvent.KEYCODE_HELP: return "menu";
      case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
      case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
      case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "playpause";
      case KeyEvent.KEYCODE_MEDIA_NEXT: return "next";
      default: return null;
    }
  }

  private boolean isPad(int keyCode) {
    return keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
        || keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT;
  }

  /** Hand a key to the page. */
  private void sendKey(String name) {
    final String js = "window.__komaTv && window.__komaTv.key(" + JSONObject.quote(name) + ")";
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        if (webView != null) webView.evaluateJavascript(js, null);
      }
    });
  }

  /**
   * The remote belongs to the page.
   *
   * The key is taken here, before the WebView ever sees it. A WebView that
   * gets the pad itself moves its own focus (and wraps round to the top of
   * the page), scrolls a little at a time, opens drop-downs and presses
   * buttons - none of which is what a television is for. The page knows what
   * has the focus and what the pad should do with it, so the page is told.
   */
  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (!BuildConfig.IS_TV) return super.dispatchKeyEvent(event);
    int code = event.getKeyCode();
    // Gboard's Search/Enter action must reach the HTML form. It is not the
    // remote's Center button, whose DPAD_CENTER event remains owned by the
    // television navigator even while a text field is active.
    if (textEntryRequested && (code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
      return super.dispatchKeyEvent(event);
    }
    String name = remoteKey(code, event);
    if (name == null) return super.dispatchKeyEvent(event);

    int action = event.getAction();
    if (action == KeyEvent.ACTION_DOWN) {
      // A held-down pad walks along the row: the repeats of the key are
      // the viewer saying "keep going". They come thick and fast, so they
      // are spaced out a little before the page is told.
      if (isPad(code)) {
        long now = android.os.SystemClock.uptimeMillis();
        if (event.getRepeatCount() == 0) {
          sendKey(name);
          lastPadKey = now;
        } else if (now - lastPadKey >= REPEAT_MS) {
          sendKey(name);
          lastPadKey = now;
        }
        return true;
      }
      // A held-down centre button opens the card's menu; a short press opens
      // the card. The page tells the two apart by the order they arrive in.
      if ("center".equals(name)) {
        if (event.getRepeatCount() == 0) {
          holdKey = new Runnable() {
            @Override
            public void run() {
              holdKey = null;
              sendKey("hold");
            }
          };
          ui.postDelayed(holdKey, 600);
        }
        return true;
      }
      if (event.getRepeatCount() == 0) sendKey(name);
      return true;
    }
    if (action == KeyEvent.ACTION_UP) {
      if ("center".equals(name)) {
        if (holdKey != null) {
          ui.removeCallbacks(holdKey);
          holdKey = null;
        }
        // The release is always sent. After a long press the page has already
        // opened the card menu; it uses this release to ignore that one
        // activation without swallowing the viewer's next press.
        sendKey("center");
      }
      return true;
    }
    return true;
  }

  private void openAccountAuth(String url) {
    try {
      stopOAuthCallbackServer();
      oauthCallbackServer = OAuthCallbackServer.start(4000);
      if (oauthCallbackServer == null) {
        webView.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('koma:sync-error',{detail:'The sign-in callback could not start. Close any app using port 4000 and try again.'}))",
          null);
        return;
      }

      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      intent.addCategory(Intent.CATEGORY_BROWSABLE);
      startActivity(intent);
    } catch (Exception error) {
      stopOAuthCallbackServer();
      traceThrowable(this, "could not open account sign-in", error);
    }
  }

  private void stopOAuthCallbackServer() {
    if (oauthCallbackServer != null) {
      oauthCallbackServer.stop();
      oauthCallbackServer = null;
    }
  }

  private void handleAuthCallback(String value) {
    if (activityGone()) return;
    stopOAuthCallbackServer();
    Uri uri;
    try { uri = Uri.parse(value); }
    catch (Exception error) { traceThrowable(this, "bad account callback", error); return; }
    if (!BuildConfig.APPLICATION_ID.equals(uri.getScheme()) || !"auth".equals(uri.getHost())) return;
    String name = uri.getPathSegments().isEmpty() ? "" : uri.getPathSegments().get(0);
    if (!"anilist".equals(name) && !"myanimelist".equals(name)) return;

    int port = sitePort();
    if (port <= 0) {
      pendingAuthCallback = value;
      return;
    }
    StringBuilder query = new StringBuilder();
    if (BuildConfig.IS_TV) query.append("tv=1");
    String callbackQuery = uri.getEncodedQuery();
    if (callbackQuery != null && !callbackQuery.isEmpty()) {
      if (query.length() > 0) query.append('&');
      query.append(callbackQuery);
    }
    StringBuilder local = new StringBuilder("http://127.0.0.1:").append(port).append("/auth/").append(name);
    if (query.length() > 0) local.append('?').append(query);
    String fragment = uri.getEncodedFragment();
    if (fragment != null && !fragment.isEmpty()) local.append('#').append(fragment);
    webView.loadUrl(local.toString());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    Uri uri = intent == null ? null : intent.getData();
    if (uri != null && BuildConfig.APPLICATION_ID.equals(uri.getScheme())) handleAuthCallback(uri.toString());
  }

  private class AccountWebViewClient extends WebViewClient {
    @Override
    public void onPageFinished(WebView view, String url) {
      super.onPageFinished(view, url);
      if ("file:///android_asset/splash.html".equals(url)) {
        if (!serversStarted) {
          serversStarted = true;
          // Let the finished splash reach the screen before loading libnode.
          view.postDelayed(() -> startServers(), 50);
        }
        return;
      }
      if (startupSplash) {
        startupSplash = false;
        // The splash is boot feedback, not a page in the viewer's Back history.
        view.clearHistory();
      }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      String url = request.getUrl() == null ? "" : request.getUrl().toString();
      if (url.startsWith(BuildConfig.APPLICATION_ID + "://auth/")) {
        handleAuthCallback(url);
        return true;
      }
      if (url.startsWith("https://anilist.co/api/v2/oauth/authorize")
          || url.startsWith("https://myanimelist.net/v1/oauth2/authorize")) {
        openAccountAuth(url);
        return true;
      }
      return false;
    }
  }
  /** Fullscreen video: the player's own button hands the view over here. */
  private class VideoChromeClient extends WebChromeClient {    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
      if (customView != null) { callback.onCustomViewHidden(); return; }
      customView = view;
      customViewCallback = callback;
      webView.setVisibility(View.GONE);
      rootLayout.addView(view, new FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @Override
    public void onHideCustomView() {
      if (customView == null) return;
      rootLayout.removeView(customView);
      customView = null;
      webView.setVisibility(View.VISIBLE);
      if (customViewCallback != null) {
        customViewCallback.onCustomViewHidden();
        customViewCallback = null;
      }
    }
  }

  @Override
  public void onBackPressed() {
    if (updatePrompt != null && updatePrompt.isShowing()) {
      updateManager.defer();
      updatePrompt.dismissAsLater();
      return;
    }
    // Fullscreen video first, then the page's own panels: the page is asked
    // whether it wants the back button - an open drawer or panel takes it -
    // and only then does the app go back.
    if (customView != null) {
      videoChromeClient.onHideCustomView();
      return;
    }
    webView.evaluateJavascript(
        "(function(){try{return !!(window.__komaBack && window.__komaBack());}catch(e){return false;}})()",
        value -> {
          if ("true".equals(value)) return;
          if (webView.canGoBack()) webView.goBack();
          else MainActivity.super.onBackPressed();
        });
  }

  @Override
  protected void onPause() {
    super.onPause();
    webView.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    webView.onResume();
    if (updateManager != null) updateManager.check(false);
  }

  @Override
  protected void onDestroy() {
    // The Node servers keep running with the app process; the WebView goes.
    stopOAuthCallbackServer();
    if (updatePrompt != null) {
      updatePrompt.dismissAsLater();
      updatePrompt = null;
    }
    if (updateManager != null) updateManager.shutdown();
    if (roomMulticastLock != null && roomMulticastLock.isHeld()) {
      try { roomMulticastLock.release(); } catch (Exception ignored) { }
      roomMulticastLock = null;
    }
    if (webView != null) {
      webView.loadUrl("about:blank");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
