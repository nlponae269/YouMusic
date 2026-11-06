package io.github.nlponae269.youmusic;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.speech.RecognizerIntent;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;

/**
 * YouMusic для Android: внутри открывается сайт, поэтому всё новое на сайте сразу появляется
 * и в приложении. Приложение добавляет то, чего нет в обычной вкладке браузера:
 * выбор файлов для загрузки, скачивание треков, голосовой поиск, кнопку «Назад»
 * и музыку, которая не останавливается, когда приложение свёрнуто.
 */
public class MainActivity extends Activity {
    static final String SITE = "https://nlponae269.github.io/YouMusic/";
    static final String HOST = "nlponae269.github.io";
    static final String OFFLINE = "file:///android_asset/offline.html";
    static final int PICK_FILES = 1;
    static final int VOICE = 2;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    String lastUrl = SITE;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0c0c10"));
        w.setNavigationBarColor(Color.parseColor("#0c0c10"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0c0c10"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " YouMusicApp/1.0");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "YouMusicApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        // обычные ссылки на файлы — в «Загрузки»
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String disposition, String mime, long length) {
                if (url.startsWith("http")) download(url, null);
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(startUrl(getIntent()));
    }

    String startUrl(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data != null && HOST.equals(data.getHost())) return data.toString();
        return SITE;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // Музыка играет и в свёрнутом приложении: WebView на паузу не ставим
    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    // «Назад»: сначала закрываем открытое на сайте (текст, плеер, меню), потом страницы,
    // а с главной сворачиваемся, не выключая музыку
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__ymBack ? window.__ymBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if ("true".equals(value)) return;
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    class Client extends WebViewClient {
        @Override
        // вариант со строкой: он есть во всех версиях Android, новые версии вызывают его сами
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (HOST.equals(uri.getHost()) && uri.getPath() != null && uri.getPath().startsWith("/YouMusic")) return false;
            // всё остальное (страницы лицензий, каталог и т. п.) — во внешнем браузере
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, "Не найдено приложение, чтобы открыть ссылку", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                lastUrl = request.getUrl().toString();
                view.loadUrl(OFFLINE);
            }
        }
    }

    class Chrome extends WebChromeClient {
        // <input type="file"> на сайте: выбор треков и обложек из памяти телефона
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            String type = types != null && types.length > 0 && types[0].length() > 0 ? types[0] : "*/*";
            if (type.startsWith(".")) type = "*/*";
            intent.setType(type.contains("/") ? type : "*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(intent, "Выбери файлы"), PICK_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && fileCallback != null) {
            Uri[] picked = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    picked = new Uri[n];
                    for (int i = 0; i < n; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    picked = new Uri[] { data.getData() };
                }
            }
            fileCallback.onReceiveValue(picked);
            fileCallback = null;
        } else if (request == VOICE && result == RESULT_OK && data != null) {
            ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (said != null && !said.isEmpty()) {
                String text = said.get(0).replace("\\", "\\\\").replace("'", "\\'");
                web.evaluateJavascript("window.__ymVoice && window.__ymVoice('" + text + "')", null);
            }
        }
    }

    void download(String url, String name) {
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String file = name != null ? name : Uri.parse(url).getLastPathSegment();
            if (file == null || file.isEmpty()) file = "YouMusic.mp3";
            r.setTitle(file);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, file);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
            Toast.makeText(this, "Скачивается в «Загрузки»", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось скачать", Toast.LENGTH_SHORT).show();
        }
    }

    /** То, что сайт может попросить у приложения: window.YouMusicApp.* */
    class Bridge {
        @JavascriptInterface
        public String version() {
            return "1.0";
        }

        @JavascriptInterface
        public void download(final String url, String name) {
            if (url == null || !url.startsWith("https://")) return;
            final String file = name == null ? null : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.download(url, file); }
            });
        }

        @JavascriptInterface
        public void voice() {
            runOnUiThread(new Runnable() { public void run() {
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU");
                i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Что включить?");
                try {
                    startActivityForResult(i, VOICE);
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "На телефоне нет голосового ввода Google", Toast.LENGTH_SHORT).show();
                }
            } });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(new Runnable() {
                public void run() { web.loadUrl(lastUrl.startsWith("http") ? lastUrl : SITE); }
            });
        }
    }
}
