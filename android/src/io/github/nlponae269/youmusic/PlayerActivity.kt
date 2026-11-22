package io.github.nlponae269.youmusic

import android.animation.ValueAnimator
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView

/**
 * Плеер на весь экран в раскладке Яндекс Музыки: на месте обложки — карточка с текущей строкой
 * текста (крупно, заглавными), ↗ — текст на весь экран; ниже название, прогресс, кнопки.
 */
class PlayerActivity : Activity(), Player.Listener {
    private fun dp(v: Int) = Ui.dp(this, v)
    private val ease = PathInterpolator(.22f, 1f, .36f, 1f)

    private lateinit var root: FrameLayout
    private lateinit var bg: View
    private lateinit var art: FrameLayout
    private lateinit var coverBox: FrameLayout
    private lateinit var card: FrameLayout
    private lateinit var cardList: LinearLayout
    private lateinit var meta: LinearLayout
    private lateinit var metaCover: FrameLayout
    private lateinit var title: TextView
    private lateinit var artist: TextView
    private lateinit var seek: SeekBar
    private lateinit var cur: TextView
    private lateinit var dur: TextView
    private lateinit var play: Icon
    private lateinit var like: Icon
    private lateinit var repeatBtn: Icon
    private lateinit var shuffleBtn: Icon
    private lateinit var lyricsBtn: Icon
    private lateinit var waveBtn: LinearLayout
    private lateinit var fullScroll: ScrollView
    private lateinit var fullList: LinearLayout

    private var lines: List<LyricLine> = emptyList()
    private var synced = false
    private var lyricsFor: String? = null
    private var active = -2
    private var cardMode = true
    private var fullMode = false
    private var touched = 0L
    private var scrollAnim: ValueAnimator? = null
    private var liked = false
    private var seeking = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        Api.init(this)
        Player.init(this)
        // система могла выгрузить приложение: без трека этот экран не нужен
        if (Player.current == null) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        cardMode = getSharedPreferences("supmusic", MODE_PRIVATE).getBoolean("lyr_card", true)
        root = FrameLayout(this)
        bg = View(this)
        root.addView(bg, FrameLayout.LayoutParams(-1, -1))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(14), dp(22), dp(16)) }
        root.addView(col, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        // верх: свернуть — «Сейчас играет» — скачать
        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        top.addView(iconBtn("down") { finish() }, Ui.lp(dp(40), dp(40)))
        top.addView(Ui.text(this, "Сейчас играет", 15f, Color.argb(220, 255, 255, 255), bold = true).apply { gravity = Gravity.CENTER }, Ui.lp(0, -2, 1f))
        top.addView(iconBtn("download") { download() }, Ui.lp(dp(40), dp(40)))
        col.addView(top)

        // обложка и карточка с текстом
        art = FrameLayout(this)
        coverBox = FrameLayout(this)
        art.addView(coverBox, FrameLayout.LayoutParams(-1, -1))
        card = FrameLayout(this).apply {
            background = Ui.round(Color.argb(36, 255, 255, 255), Ui.dpf(context, 22f))
            clipChildren = true; clipToOutline = true
            setOnClickListener { setFull(true) }
        }
        cardList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), 0, dp(22), 0) }
        card.addView(cardList, FrameLayout.LayoutParams(-1, -2))
        card.addView(iconBtn("expand") { setFull(true) }, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(8), dp(8), 0) })
        art.addView(card, FrameLayout.LayoutParams(-1, -1))
        col.addView(art, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(10); bottomMargin = dp(16) })

        // текст на весь экран (скрыт, пока не открыт)
        fullScroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; visibility = View.GONE; isFillViewport = true }
        fullList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        fullScroll.addView(fullList)
        fullScroll.setOnTouchListener { _, e -> if (e.action == MotionEvent.ACTION_DOWN || e.action == MotionEvent.ACTION_MOVE) { touched = System.currentTimeMillis(); scrollAnim?.cancel() }; false }
        col.addView(fullScroll, LinearLayout.LayoutParams(-1, 0, 1f))

        // название и исполнитель
        meta = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        metaCover = FrameLayout(this)
        meta.addView(metaCover, Ui.lp(dp(56), dp(56)))
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, dp(8), 0) }
        title = Ui.text(this, "", 22f, bold = true); artist = Ui.text(this, "", 16f, Color.argb(160, 255, 255, 255))
        names.addView(title); names.addView(artist)
        meta.addView(names, Ui.lp(0, -2, 1f))
        meta.addView(iconBtn("share") { share() }, Ui.lp(dp(40), dp(40)))
        col.addView(meta)

        // прогресс
        seek = SeekBar(this).apply {
            max = 1000
            progressDrawable.setTint(Ui.ACCENT)
            thumb.setTint(Color.WHITE)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar?, p: Int, user: Boolean) {}
                override fun onStartTrackingTouch(s: SeekBar?) { seeking = true }
                override fun onStopTrackingTouch(s: SeekBar?) { seeking = false; Player.seek(progress / 1000.0 * Player.duration) }
            })
        }
        col.addView(seek, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
        val times = LinearLayout(this).apply { setPadding(dp(16), 0, dp(16), 0) }
        cur = Ui.text(this, "0:00", 13f, Color.argb(160, 255, 255, 255)); dur = Ui.text(this, "0:00", 13f, Color.argb(160, 255, 255, 255))
        times.addView(cur, Ui.lp(0, -2, 1f)); times.addView(dur)
        col.addView(times)

        // кнопки: скачать — назад — играть (жёлтая) — вперёд — нравится
        val btns = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10), 0, dp(10)) }
        btns.addView(iconBtn("download") { download() }, Ui.lp(0, dp(44), 1f))
        btns.addView(iconBtn("prev") { Player.prev() }, Ui.lp(0, dp(48), 1f))
        play = Icon(this, "play", Color.parseColor("#111111")).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Ui.ACCENT) }
            setPadding(dp(22), dp(22), dp(22), dp(22))
            setOnClickListener { Player.toggle() }
        }
        btns.addView(play, Ui.lp(dp(78), dp(78)))
        btns.addView(iconBtn("next") { Player.next() }, Ui.lp(0, dp(48), 1f))
        like = iconBtn("heart") { toggleLike() }
        btns.addView(like, Ui.lp(0, dp(44), 1f))
        col.addView(btns)

        // кнопки-таблетки: повтор — текст — перемешать
        val pills = LinearLayout(this)
        repeatBtn = iconBtn("repeat") { Player.repeat = (Player.repeat + 1) % 3; renderModes(); Ui.toast(this, listOf("Повтор выключен", "Повторять всё", "Повторять трек")[Player.repeat]) }
        lyricsBtn = iconBtn("lyrics") { onLyricsBtn() }
        shuffleBtn = iconBtn("shuffle") { Player.shuffle = !Player.shuffle; renderModes() }
        for ((v, w) in listOf(repeatBtn to 1f, lyricsBtn to 1.25f, shuffleBtn to 1f)) {
            v.setPadding(dp(15), dp(15), dp(15), dp(15))
            pills.addView(v, LinearLayout.LayoutParams(0, dp(54), w).apply { setMargins(dp(6), 0, dp(6), 0) })
        }
        col.addView(pills)

        // «Моя волна по треку»
        waveBtn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.argb(46, 255, 255, 255), Color.argb(14, 255, 255, 255), Color.argb(50, 255, 255, 255))).apply { cornerRadius = Ui.dpf(context, 22f) }
            setOnClickListener { waveByTrack() }
        }
        waveBtn.addView(Ui.text(this, "Моя волна по треку", 14f, Color.argb(190, 255, 255, 255)).apply { gravity = Gravity.CENTER })
        waveBtn.addView(Ui.text(this, "", 19f, bold = true).apply { gravity = Gravity.CENTER; tag = "wave-title" })
        col.addView(waveBtn, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })

        Player.listen(this)
        Bg.run({ if (Api.loggedIn) Api.likes() else emptySet() }, { l -> liked = Player.current?.id in l; renderLike() })
        onTrack()
        tick()
    }

    override fun onDestroy() { Player.unlisten(this); Ui.main.removeCallbacks(ticker); super.onDestroy() }

    private fun iconBtn(kind: String, onClick: () -> Unit) = Icon(this, kind).apply {
        setPadding(dp(9), dp(9), dp(9), dp(9))
        setOnClickListener { onClick() }
    }

    // ---------- трек ----------

    override fun onTrack() {
        val t = Player.current ?: return finish()
        title.text = t.title; artist.text = t.artist
        waveBtn.findViewWithTag<TextView>("wave-title").text = "▶ " + t.title
        // фон — цвет по названию трека, как на сайте
        val h = Ui.hue(t.title)
        bg.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(Color.HSVToColor(floatArrayOf(h, .55f, .42f)), Color.HSVToColor(floatArrayOf((h + 40) % 360, .6f, .2f)), Ui.BG))
        coverBox.removeAllViews()
        art.post { coverBox.addView(Ui.cover(this, t, art.width, Ui.dpf(this, 22f)), FrameLayout.LayoutParams(-1, -1)) }
        metaCover.removeAllViews()
        metaCover.addView(Ui.cover(this, t, dp(56), 0f, circle = true), FrameLayout.LayoutParams(-1, -1))
        renderModes(); onState()
        if (lyricsFor != t.id) loadLyrics(t)
    }

    override fun onState() {
        play.kind = if (Player.playing) "pause" else "play"
    }

    private fun renderModes() {
        repeatBtn.color = if (Player.repeat > 0) Ui.ACCENT else Color.WHITE
        shuffleBtn.color = if (Player.shuffle) Ui.ACCENT else Color.WHITE
        for (v in listOf(repeatBtn, shuffleBtn)) { v.background = Ui.round(Color.argb(32, 255, 255, 255), Ui.dpf(this, 999f)); v.invalidate() }
        val on = lines.isNotEmpty() && (cardMode || fullMode)
        lyricsBtn.background = GradientDrawable().apply {
            cornerRadius = Ui.dpf(this@PlayerActivity, 999f)
            if (on) setStroke(dp(2), Color.WHITE) else setColor(Color.argb(32, 255, 255, 255))
        }
        lyricsBtn.alpha = if (lines.isEmpty()) .35f else 1f
    }

    private fun renderLike() {
        like.kind = if (liked) "heart-on" else "heart"
        like.color = if (liked) Ui.ACCENT else Color.WHITE
    }

    private fun toggleLike() {
        val t = Player.current ?: return
        if (!Api.loggedIn) { Ui.toast(this, "Войди в аккаунт — вкладка «Коллекция»"); return }
        liked = !liked; renderLike()
        Bg.run({ Api.setLike(t.id, liked) }, {}, { e -> Ui.toast(this, e.message ?: "Ошибка") })
    }

    private fun download() {
        val t = Player.current ?: return
        val name = "${t.artist} - ${t.title}.mp3".replace(Regex("[\\\\/:*?\"<>|]"), "_")
        try {
            val r = DownloadManager.Request(Uri.parse(Api.audioUrl(t))).setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(r)
            Ui.toast(this, "Скачивается в «Загрузки»")
        } catch (e: Exception) { Ui.toast(this, "Не удалось скачать") }
    }

    private fun share() {
        val t = Player.current ?: return
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "${t.artist} — ${t.title}\nhttps://nlponae269.github.io/YouMusic/#/track/${t.id}"), "Поделиться"))
    }

    /** Волна по треку: сначала этот же исполнитель, потом весь каталог вперемешку. */
    private fun waveByTrack() {
        val t = Player.current ?: return
        Bg.run({ Api.all().filter { it.playable } }, { pool ->
            val same = pool.filter { it.artist == t.artist && it.id != t.id }.shuffled()
            val rest = pool.filter { it.artist != t.artist }.shuffled()
            Player.shuffle = false
            Player.setQueue(listOf(t) + same + rest, t)
            renderModes()
            Ui.toast(this, "Моя волна по треку «${t.title}»")
        })
    }

    // ---------- текст песни ----------

    private fun loadLyrics(t: Track) {
        lyricsFor = t.id; lines = emptyList(); active = -2
        cardList.removeAllViews(); fullList.removeAllViews()
        renderLyrics()
        Bg.run({ Api.lyrics(t.id) }, { raw ->
            if (lyricsFor != t.id) return@run
            val (l, s) = Lyrics.parse(raw)
            lines = l; synced = s
            buildLyrics(); renderLyrics(); sync(true)
        })
    }

    private fun lineView(text: String, size: Float, upper: Boolean, center: Boolean) = TextView(this).apply {
        this.text = if (text.isEmpty()) "● ● ● ●" else if (upper) text.uppercase() else text
        textSize = size
        setTextColor(Color.WHITE)
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        letterSpacing = -0.02f
        setLineSpacing(0f, 0.95f)
        gravity = if (center) Gravity.CENTER_HORIZONTAL else Gravity.START
    }

    private fun buildLyrics() {
        cardList.removeAllViews(); fullList.removeAllViews()
        // отступы сверху и снизу, чтобы первая и последняя строки могли встать на нужную высоту
        fullList.addView(View(this), LinearLayout.LayoutParams(-1, resources.displayMetrics.heightPixels / 3))
        lines.forEachIndexed { i, l ->
            if (synced) cardList.addView(lineView(l.text, 30f, true, true).apply { alpha = .35f },
                LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) })
            fullList.addView(lineView(l.text, if (synced) 32f else 20f, false, true).apply {
                alpha = if (synced) .3f else .92f
                setOnClickListener { if (synced) { Player.seek(lines[i].time); touched = 0 } }
            }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(if (synced) 22 else 8) })
        }
        if (!synced) cardList.addView(lineView(lines.joinToString("\n") { it.text }, 18f, false, false))
        fullList.addView(View(this), LinearLayout.LayoutParams(-1, resources.displayMetrics.heightPixels / 2))
    }

    private fun renderLyrics() {
        val has = lines.isNotEmpty()
        if (!has) fullMode = false
        card.visibility = if (has && cardMode && !fullMode) View.VISIBLE else View.GONE
        coverBox.visibility = if (card.visibility == View.VISIBLE) View.INVISIBLE else View.VISIBLE
        fullScroll.visibility = if (fullMode) View.VISIBLE else View.GONE
        art.visibility = if (fullMode) View.GONE else View.VISIBLE
        meta.visibility = if (fullMode) View.GONE else View.VISIBLE
        waveBtn.visibility = if (fullMode) View.GONE else View.VISIBLE
        renderModes()
    }

    private fun onLyricsBtn() {
        if (lines.isEmpty()) { Ui.toast(this, "Текста для этого трека пока нет"); return }
        if (fullMode) setFull(false) else {
            cardMode = !cardMode
            getSharedPreferences("supmusic", MODE_PRIVATE).edit().putBoolean("lyr_card", cardMode).apply()
            renderLyrics(); sync(true)
        }
    }

    private fun setFull(on: Boolean) {
        if (lines.isEmpty()) return
        fullMode = on; touched = 0
        renderLyrics()
        fullScroll.post { sync(true) }
    }

    @Deprecated("Activity API")
    override fun onBackPressed() { if (fullMode) setFull(false) else super.onBackPressed() }

    private fun sync(force: Boolean = false) {
        if (!synced || lines.isEmpty()) return
        val idx = Lyrics.current(lines, Player.position)
        val gap = idx < 0 || lines[idx].text.isEmpty()
        if (gap) dots(idx)
        if (idx == active && !force) return
        active = idx
        val focus = maxOf(idx, 0)
        // карточка: лента строк мягко едет вверх, текущая — белая, прошедшие гаснут
        for (i in 0 until cardList.childCount) {
            val v = cardList.getChildAt(i)
            v.animate().alpha(if (i == focus) 1f else if (i < focus) 0f else .35f)
                .scaleX(if (i == focus) 1f else .94f).scaleY(if (i == focus) 1f else .94f).setDuration(600).setInterpolator(ease).start()
        }
        cardList.getChildAt(focus)?.let { v ->
            val target = card.height * 0.3f - v.top
            if (force) cardList.translationY = target else cardList.animate().translationY(target).setDuration(750).setInterpolator(ease).start()
        }
        // весь текст: яркость и размытие по удалённости от текущей строки
        for (i in 1 until fullList.childCount - 1) {
            val li = i - 1
            val d = li - idx
            val a = when { d == 0 -> 1f; d < 0 -> .22f; d == 1 -> .55f; d == 2 -> .4f; d == 3 -> .28f; else -> .18f }
            fullList.getChildAt(i).animate().alpha(a).scaleX(if (d == 0) 1f else .95f).scaleY(if (d == 0) 1f else .95f)
                .setDuration(700).setInterpolator(ease).start()
        }
        if (fullMode && System.currentTimeMillis() - touched > 3500) {
            fullList.getChildAt(focus + 1)?.let { v ->
                val target = (v.top - fullScroll.height * 0.35f).toInt().coerceAtLeast(0)
                scrollAnim?.cancel()
                if (force) fullScroll.scrollTo(0, target)
                else scrollAnim = ValueAnimator.ofInt(fullScroll.scrollY, target).apply {
                    duration = 700; interpolator = ease
                    addUpdateListener { fullScroll.scrollTo(0, it.animatedValue as Int) }
                    start()
                }
            }
        }
    }

    /** Проигрыш: точки загораются по одной, пока он идёт. */
    private fun dots(idx: Int) {
        val start = if (idx < 0) 0.0 else lines[idx].time
        val end = lines.getOrNull(idx + 1)?.time ?: (Player.duration.takeIf { it > 0 } ?: (start + 8))
        val k = ((Player.position - start) / maxOf(1.0, end - start)).coerceIn(0.0, 1.0)
        val lit = (k * 5).toInt().coerceIn(0, 4)
        val text = (0 until 4).joinToString(" ") { if (it < lit) "●" else "○" }
        (cardList.getChildAt(maxOf(idx, 0)) as? TextView)?.text = text
        (fullList.getChildAt(maxOf(idx, 0) + 1) as? TextView)?.text = text
    }

    // ---------- время ----------

    private val ticker = Runnable { tick() }
    private fun tick() {
        val d = Player.duration
        val p = Player.position
        if (!seeking) seek.progress = if (d > 0) (p / d * 1000).toInt() else 0
        cur.text = Ui.fmt(p); dur.text = Ui.fmt(d)
        sync()
        Ui.main.postDelayed(ticker, 150)
    }
}
