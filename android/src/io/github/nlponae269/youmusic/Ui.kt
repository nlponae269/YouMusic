package io.github.nlponae269.youmusic

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Цвета и мелочи оформления supMUSIC. Экраны собираются кодом, без XML-разметки. */
object Ui {
    val BG = Color.parseColor("#0d0d0f")
    val S1 = Color.parseColor("#161619")
    val S2 = Color.parseColor("#202025")
    val S3 = Color.parseColor("#2b2b32")
    val DIM = Color.parseColor("#8e8e9a")
    val ACCENT = Color.parseColor("#ffdd33")
    val TEXT = Color.WHITE
    val main = Handler(Looper.getMainLooper())

    fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()
    fun dpf(c: Context, v: Float) = v * c.resources.displayMetrics.density

    fun toast(c: Context, msg: String) = main.post { Toast.makeText(c.applicationContext, msg, Toast.LENGTH_SHORT).show() }

    fun text(c: Context, s: String, size: Float, color: Int = TEXT, bold: Boolean = false, lines: Int = 1) = TextView(c).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        if (lines > 0) { maxLines = lines; ellipsize = TextUtils.TruncateAt.END }
    }

    fun round(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radius }

    fun hue(s: String): Float { var h = 0; for (ch in s) h = (h * 31 + ch.code) % 360; return h.toFloat() }

    /** Обложка без картинки: градиент по названию и первая буква, как на сайте. */
    fun placeholder(c: Context, key: String, radius: Float): View {
        val h = hue(key)
        return TextView(c).apply {
            text = key.trim().take(1).uppercase()
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            textSize = 20f
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.HSVToColor(floatArrayOf(h, .62f, .86f)), Color.HSVToColor(floatArrayOf((h + 50) % 360, .7f, .45f))))
                .apply { cornerRadius = radius }
        }
    }

    /** Квадратная обложка трека: картинка или градиент с буквой. */
    fun cover(c: Context, t: Track?, size: Int, radius: Float, circle: Boolean = false): FrameLayout {
        val box = FrameLayout(c)
        box.layoutParams = ViewGroup.LayoutParams(size, size)
        val r = if (circle) size / 2f else radius
        box.addView(placeholder(c, t?.title ?: "♪", r), FrameLayout.LayoutParams(-1, -1))
        box.clipToOutline = true
        box.background = round(S2, r)
        val url = t?.let { Api.coverUrl(it) }
        if (url != null) {
            val img = ImageView(c).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
            box.addView(img, FrameLayout.LayoutParams(-1, -1))
            img.tag = url
            Images.load(url) { bmp -> if (img.tag == url) img.setImageBitmap(bmp) }
        }
        return box
    }

    fun fmt(sec: Double): String { val s = maxOf(0, sec.toInt()); return "${s / 60}:${(s % 60).toString().padStart(2, '0')}" }

    fun lp(w: Int, h: Int, weight: Float = 0f) = LinearLayout.LayoutParams(w, h, weight)
}

/** Загрузка картинок по сети с кэшем в памяти. */
object Images {
    private val cache = LruCache<String, Bitmap>(40)
    private val pool = Executors.newFixedThreadPool(3)

    fun load(url: String, done: (Bitmap) -> Unit) {
        cache.get(url)?.let { done(it); return }
        pool.execute {
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 10000; c.readTimeout = 20000
                val bmp = c.inputStream.use { BitmapFactory.decodeStream(it) } ?: return@execute
                cache.put(url, bmp)
                Ui.main.post { done(bmp) }
            } catch (e: Exception) { /* без обложки */ }
        }
    }
}

/** Фоновая задача: работа в отдельном потоке, результат — в основном. */
object Bg {
    private val pool = Executors.newFixedThreadPool(4)
    fun <T> run(work: () -> T, done: (T) -> Unit, fail: (Exception) -> Unit = {}) {
        pool.execute {
            try { val r = work(); Ui.main.post { done(r) } } catch (e: Exception) { Ui.main.post { fail(e) } }
        }
    }
}
