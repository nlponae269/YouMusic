package io.github.nlponae269.youmusic

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Calendar

/** Главный экран: вкладки «Главное», «Поиск», «Коллекция», «Создать», «Загрузить» и мини-плеер. */
class MainActivity : Activity(), Player.Listener {
    private lateinit var content: FrameLayout
    private lateinit var tabs: LinearLayout
    private lateinit var mini: LinearLayout
    private lateinit var miniCover: FrameLayout
    private lateinit var miniTitle: TextView
    private lateinit var miniArtist: TextView
    private lateinit var miniPlay: Icon
    private lateinit var miniLine: View
    private var tab = "home"
    private var likes = mutableSetOf<String>()
    private var pickedAudio: Uri? = null
    private var onVoice: ((String) -> Unit)? = null

    private fun dp(v: Int) = Ui.dp(this, v)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        Api.init(this)
        Player.init(this)
        window.statusBarColor = Ui.BG
        window.navigationBarColor = Ui.BG
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Ui.BG) }
        content = FrameLayout(this)
        root.addView(content, Ui.lp(-1, 0, 1f))
        root.addView(buildMini(), Ui.lp(-1, -2))
        tabs = LinearLayout(this).apply { setBackgroundColor(Color.parseColor("#f20d0d0f")); setPadding(0, dp(6), 0, dp(6)) }
        root.addView(tabs, Ui.lp(-1, -2))
        setContentView(root)
        buildTabs()
        show("loading")
        Bg.run({ Api.loadConfig(); if (Api.loggedIn) Api.likes() else emptySet() }, { l ->
            likes = l.toMutableSet(); show(tab)
        }, { e -> show("error", e.message) })
        Player.listen(this)
        renderMini()
        tick()
    }

    override fun onDestroy() { Player.unlisten(this); super.onDestroy() }
    override fun onTrack() = renderMini()
    override fun onState() = renderMini()

    private val ticker = Runnable { tick() }
    private fun tick() {
        val d = Player.duration
        miniLine.layoutParams = (miniLine.layoutParams as FrameLayout.LayoutParams).apply {
            width = if (d > 0) (mini.width * (Player.position / d)).toInt() else 0
        }
        miniLine.requestLayout()
        Ui.main.postDelayed(ticker, 500)
    }

    // ---------- мини-плеер ----------

    private fun buildMini(): View {
        val wrap = FrameLayout(this)
        mini = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(8), dp(8), dp(8))
            background = Ui.round(Ui.S1, Ui.dpf(context, 18f))
            setOnClickListener { if (Player.current != null) startActivity(Intent(context, PlayerActivity::class.java)) }
        }
        miniCover = FrameLayout(this)
        mini.addView(miniCover, Ui.lp(dp(46), dp(46)))
        val meta = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(8), 0) }
        miniTitle = Ui.text(this, "Ничего не играет", 15f, bold = true)
        miniArtist = Ui.text(this, "Выбери трек или включи «Мою волну»", 13f, Ui.DIM)
        meta.addView(miniTitle); meta.addView(miniArtist)
        mini.addView(meta, Ui.lp(0, -2, 1f))
        miniPlay = Icon(this, "play", Color.BLACK).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
            setPadding(dp(11), dp(11), dp(11), dp(11))
            setOnClickListener { if (Player.current == null) Ui.toast(context, "Выбери трек или включи «Мою волну»") else Player.toggle() }
        }
        mini.addView(miniPlay, Ui.lp(dp(44), dp(44)))
        mini.addView(Icon(this, "next").apply { setPadding(dp(10), dp(10), dp(10), dp(10)); setOnClickListener { Player.next() } }, Ui.lp(dp(44), dp(44)))
        wrap.addView(mini, FrameLayout.LayoutParams(-1, -2).apply { setMargins(dp(8), dp(4), dp(8), dp(4)) })
        miniLine = View(this).apply { setBackgroundColor(Ui.ACCENT) }
        wrap.addView(miniLine, FrameLayout.LayoutParams(0, dp(2), Gravity.BOTTOM).apply { setMargins(dp(20), 0, 0, dp(4)) })
        return wrap
    }

    private fun renderMini() {
        val t = Player.current
        miniTitle.text = t?.title ?: "Ничего не играет"
        miniArtist.text = t?.artist ?: "Выбери трек или включи «Мою волну»"
        miniPlay.kind = if (Player.playing) "pause" else "play"
        miniCover.removeAllViews()
        miniCover.addView(Ui.cover(this, t, dp(46), Ui.dpf(this, 10f)), FrameLayout.LayoutParams(-1, -1))
    }

    // ---------- вкладки ----------

    private val TABS = listOf("home" to ("home" to "Главное"), "search" to ("search" to "Поиск"),
        "collection" to ("library" to "Коллекция"), "create" to ("spark" to "Создать"), "upload" to ("upload" to "Загрузить"))

    private fun buildTabs() {
        tabs.removeAllViews()
        for ((id, v) in TABS) {
            val (icon, label) = v
            val on = id == tab
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setOnClickListener { show(id) }
            }
            col.addView(Icon(this, icon, if (on) Ui.ACCENT else Ui.DIM), Ui.lp(dp(24), dp(24)))
            col.addView(Ui.text(this, label, 11f, if (on) Ui.TEXT else Ui.DIM, bold = on).apply { gravity = Gravity.CENTER })
            tabs.addView(col, Ui.lp(0, -2, 1f))
        }
    }

    private fun page(): LinearLayout {
        content.removeAllViews()
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(18), dp(16), dp(24)) }
        scroll.addView(col)
        content.addView(scroll)
        return col
    }

    private fun h1(col: LinearLayout, s: String) = col.addView(Ui.text(this, s, 28f, bold = true, lines = 2).apply { setPadding(0, 0, 0, dp(14)) })
    private fun h2(col: LinearLayout, s: String) = col.addView(Ui.text(this, s, 20f, bold = true).apply { setPadding(0, dp(20), 0, dp(10)) })
    private fun note(col: LinearLayout, s: String) = col.addView(Ui.text(this, s, 15f, Ui.DIM, lines = 0).apply { setPadding(0, dp(8), 0, dp(8)) })

    private fun show(id: String, extra: String? = null) {
        if (id in TABS.map { it.first }) { tab = id; buildTabs() }
        when (id) {
            "loading" -> page().also { note(it, "Загрузка…") }
            "error" -> page().also { col ->
                h1(col, "supMUSIC"); note(col, extra ?: "Нет связи")
                col.addView(button("Повторить") { recreate() })
            }
            "home" -> home()
            "search" -> search()
            "collection" -> collection()
            "create" -> create()
            "upload" -> upload()
        }
    }

    private fun button(label: String, accent: Boolean = true, onClick: () -> Unit) = TextView(this).apply {
        text = label
        gravity = Gravity.CENTER
        textSize = 16f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(if (accent) Color.BLACK else Ui.TEXT)
        background = Ui.round(if (accent) Ui.ACCENT else Ui.S2, Ui.dpf(context, 999f))
        setPadding(dp(22), dp(13), dp(22), dp(13))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
    }

    private fun field(hint: String, value: String = "", type: Int = InputType.TYPE_CLASS_TEXT, multi: Boolean = false) = EditText(this).apply {
        this.hint = hint
        setText(value)
        setTextColor(Ui.TEXT)
        setHintTextColor(Ui.DIM)
        inputType = if (multi) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
        if (multi) { minLines = 5; gravity = Gravity.TOP }
        background = Ui.round(Ui.S2, Ui.dpf(context, 12f))
        setPadding(dp(14), dp(12), dp(14), dp(12))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
    }

    // ---------- строки треков ----------

    private fun trackList(col: LinearLayout, list: List<Track>, mine: Boolean = false, onChange: () -> Unit = {}) {
        if (list.isEmpty()) { note(col, "Здесь пока пусто"); return }
        list.forEachIndexed { i, t ->
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(7), 0, dp(7))
                setOnClickListener { Player.play(list, i) }
            }
            row.addView(Ui.cover(this, t, dp(52), Ui.dpf(this, 10f)).apply { alpha = if (t.playable) 1f else .45f }, Ui.lp(dp(52), dp(52)))
            val meta = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(8), 0) }
            meta.addView(Ui.text(this, t.title, 16f, bold = true))
            val sub = when {
                t.error == "rechecking" -> "Трек временно недоступен"
                t.status == "pending" || t.status == "processing" -> "На проверке нейросетью…"
                t.status == "failed" -> "Ошибка обработки" + (t.error?.let { " — $it" } ?: "")
                else -> t.artist + if (t.album == "Сгенерировано нейросетью") " · ИИ" else ""
            }
            meta.addView(Ui.text(this, sub, 13f, if (t.playable) Ui.DIM else Ui.ACCENT))
            row.addView(meta, Ui.lp(0, -2, 1f))
            val on = t.id in likes
            row.addView(Icon(this, if (on) "heart-on" else "heart", if (on) Ui.ACCENT else Ui.DIM).apply {
                setPadding(dp(8), dp(8), dp(8), dp(8))
                setOnClickListener { like(t, this) }
            }, Ui.lp(dp(40), dp(40)))
            if (mine) row.addView(Icon(this, "trash", Ui.DIM).apply {
                setPadding(dp(9), dp(9), dp(9), dp(9))
                setOnClickListener {
                    android.app.AlertDialog.Builder(context).setMessage("Удалить «${t.title}»?")
                        .setPositiveButton("Удалить") { _, _ -> Bg.run({ Api.deleteTrack(t) }, { Ui.toast(context, "Трек удалён"); onChange() }, { e -> Ui.toast(context, e.message ?: "Ошибка") }) }
                        .setNegativeButton("Отмена", null).show()
                }
            }, Ui.lp(dp(40), dp(40)))
            else row.addView(Ui.text(this, Ui.fmt(t.duration.toDouble()), 13f, Ui.DIM))
            col.addView(row)
        }
    }

    private fun like(t: Track, icon: Icon) {
        if (!Api.loggedIn) { Ui.toast(this, "Войди в аккаунт — вкладка «Коллекция»"); show("collection"); return }
        val on = t.id !in likes
        if (on) likes += t.id else likes -= t.id
        icon.kind = if (on) "heart-on" else "heart"; icon.color = if (on) Ui.ACCENT else Ui.DIM; icon.invalidate()
        Bg.run({ Api.setLike(t.id, on) }, {}, { e -> Ui.toast(this, e.message ?: "Ошибка") })
    }

    // ---------- Главное ----------

    private fun greeting(): String {
        val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        return if (h < 5) "Доброй ночи" else if (h < 12) "Доброе утро" else if (h < 18) "Добрый день" else "Добрый вечер"
    }

    private fun home() {
        val col = page()
        h1(col, greeting())
        // «Моя волна»
        val wave = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.parseColor("#2b2410"), Color.parseColor("#141416"))).apply { cornerRadius = Ui.dpf(context, 26f) }
            setPadding(dp(22), dp(22), dp(22), dp(22))
        }
        val waveText = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        waveText.addView(Ui.text(this, "Моя волна", 34f, bold = true))
        waveText.addView(Ui.text(this, "Бесконечная музыка из всего каталога", 15f, Ui.DIM, lines = 2))
        wave.addView(waveText, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { rightMargin = dp(70) })
        wave.addView(Icon(this, "play", Color.BLACK).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Ui.ACCENT) }
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }, FrameLayout.LayoutParams(dp(60), dp(60), Gravity.BOTTOM or Gravity.END))
        wave.setOnClickListener {
            Bg.run({ Api.all().filter { it.playable }.shuffled() }, { pool ->
                if (pool.isEmpty()) Ui.toast(this, "Каталог пока пуст") else { Player.shuffle = true; Player.play(pool, 0) }
            }, { e -> Ui.toast(this, e.message ?: "Ошибка") })
        }
        col.addView(wave, LinearLayout.LayoutParams(-1, dp(200)))
        val popularBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val freshBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(popularBox); col.addView(freshBox)
        Bg.run({ Api.popular() to Api.fresh() }, { (top, fresh) ->
            if (top.isNotEmpty()) {
                h2(popularBox, "Популярное")
                val hs = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false }
                val row = LinearLayout(this)
                top.forEachIndexed { i, t ->
                    val card = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        setPadding(0, 0, dp(12), 0)
                        setOnClickListener { Player.play(top, i) }
                    }
                    card.addView(Ui.cover(this, t, dp(140), Ui.dpf(this, 16f)).apply { alpha = if (t.playable) 1f else .45f }, Ui.lp(dp(140), dp(140)))
                    card.addView(Ui.text(this, t.title, 14f, bold = true).apply { maxWidth = dp(140); setPadding(0, dp(8), 0, 0) })
                    card.addView(Ui.text(this, if (t.playable) t.artist else "Временно недоступен", 13f, Ui.DIM).apply { maxWidth = dp(140) })
                    row.addView(card)
                }
                hs.addView(row); popularBox.addView(hs)
            }
            h2(freshBox, "Новое")
            trackList(freshBox, fresh)
        }, { e -> note(freshBox, e.message ?: "Ошибка") })
    }

    // ---------- Поиск ----------

    private fun search() {
        val col = page()
        h1(col, "Поиск")
        val bar = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = Ui.round(Ui.S2, Ui.dpf(context, 999f))
            setPadding(dp(14), 0, dp(6), 0)
        }
        bar.addView(Icon(this, "search", Ui.DIM), Ui.lp(dp(22), dp(22)))
        val input = EditText(this).apply {
            hint = "Трек или исполнитель"
            setTextColor(Ui.TEXT); setHintTextColor(Ui.DIM)
            background = null
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine()
        }
        bar.addView(input, Ui.lp(0, dp(50), 1f))
        bar.addView(Icon(this, "mic", Ui.DIM).apply {
            setPadding(dp(9), dp(9), dp(9), dp(9))
            setOnClickListener { voice { input.setText(it); input.setSelection(it.length) } }
        }, Ui.lp(dp(42), dp(42)))
        col.addView(bar)
        val res = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, 0) }
        col.addView(res)
        var n = 0
        val run = Runnable {
            val q = input.text.toString().trim()
            val my = ++n
            res.removeAllViews()
            if (q.isEmpty()) { note(res, "Начни вводить название или исполнителя"); return@Runnable }
            Bg.run({ Api.search(q) }, { list -> if (my == n) { res.removeAllViews(); trackList(res, list) } }, { e -> note(res, e.message ?: "Ошибка") })
        }
        input.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { Ui.main.removeCallbacks(run); Ui.main.postDelayed(run, 300) }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        run.run()
    }

    private fun voice(done: (String) -> Unit) {
        onVoice = done
        try {
            startActivityForResult(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Что включить?"), 2)
        } catch (e: Exception) { Ui.toast(this, "На телефоне нет голосового ввода Google") }
    }

    // ---------- Коллекция и вход ----------

    private fun collection() {
        val col = page()
        h1(col, "Коллекция")
        if (!Api.loggedIn) return auth(col)
        val head = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        head.addView(Ui.text(this, Api.email ?: "", 15f, Ui.DIM), Ui.lp(0, -2, 1f))
        head.addView(button("Выйти", accent = false) { Api.signOut(); likes.clear(); show("collection") }.apply { layoutParams = Ui.lp(-2, -2) })
        col.addView(head)
        val liked = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val mine = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        h2(col, "Мне нравится"); col.addView(liked)
        h2(col, "Мои загрузки"); col.addView(mine)
        Bg.run({ Api.likes().also { likes = it.toMutableSet() }.let { Api.byIds(it) } to Api.mine() }, { (l, m) ->
            trackList(liked, l); trackList(mine, m, mine = true) { show("collection") }
        }, { e -> note(liked, e.message ?: "Ошибка") })
    }

    private fun auth(col: LinearLayout, signup: Boolean = false) {
        note(col, if (signup) "Создай аккаунт, чтобы лайкать треки, загружать музыку и создавать песни." else "Войди, чтобы лайкать треки, загружать музыку и создавать песни.")
        val name = field("Имя")
        if (signup) col.addView(name)
        val email = field("Почта", Api.email ?: "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val pass = field("Пароль (от 6 символов)", type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        col.addView(email); col.addView(pass)
        col.addView(button(if (signup) "Создать аккаунт" else "Войти") {
            val e = email.text.toString().trim(); val p = pass.text.toString()
            if (e.isEmpty() || p.length < 6) { Ui.toast(this, "Введи почту и пароль от 6 символов"); return@button }
            Bg.run({ if (signup) Api.signUp(e, p, name.text.toString().trim().ifEmpty { e.substringBefore('@') }) else { Api.signIn(e, p); true } }, { ok ->
                if (ok) { Ui.toast(this, "Добро пожаловать!"); show("collection") } else Ui.toast(this, "Проверь почту: мы отправили письмо для подтверждения")
            }, { ex -> Ui.toast(this, ex.message ?: "Ошибка") })
        })
        col.addView(button(if (signup) "Уже есть аккаунт" else "Нет аккаунта? Регистрация", accent = false) {
            val c = page(); h1(c, "Коллекция"); auth(c, !signup)
        })
        if (!signup) col.addView(Ui.text(this, "Забыли пароль?", 15f, Ui.DIM).apply {
            gravity = Gravity.CENTER; setPadding(0, dp(16), 0, 0)
            paintFlags = paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
            setOnClickListener {
                val e = email.text.toString().trim()
                if (e.isEmpty()) { Ui.toast(context, "Введи почту в поле выше"); return@setOnClickListener }
                Bg.run({ Api.resetPassword(e) }, { Ui.toast(context, "Письмо со ссылкой отправлено на $e") }, { ex -> Ui.toast(context, ex.message ?: "Ошибка") })
            }
        })
    }

    // ---------- Создать песню (нейросеть ACE-Step) ----------

    private fun chips(col: LinearLayout, label: String, items: List<Pair<String, String>>, multi: Boolean, def: Int = 0): () -> List<String> {
        col.addView(Ui.text(this, label, 13f, Ui.DIM, bold = true).apply { setPadding(0, dp(14), 0, dp(6)) })
        val hs = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false }
        val row = LinearLayout(this)
        val picked = mutableSetOf<Int>().apply { if (!multi) add(def) }
        val views = mutableListOf<TextView>()
        fun paint() = views.forEachIndexed { i, v ->
            val on = i in picked
            v.setTextColor(if (on) Color.BLACK else Ui.DIM)
            v.background = Ui.round(if (on) Ui.ACCENT else Ui.S2, Ui.dpf(this, 999f))
        }
        items.forEachIndexed { i, (l, _) ->
            val v = Ui.text(this, l, 14f, bold = true).apply {
                setPadding(dp(14), dp(8), dp(14), dp(8))
                setOnClickListener { if (multi) { if (!picked.remove(i)) picked.add(i) } else { picked.clear(); picked.add(i) }; paint() }
            }
            views += v
            row.addView(v, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8) })
        }
        paint()
        hs.addView(row); col.addView(hs)
        return { picked.sorted().map { items[it].second } }
    }

    private fun create() {
        val col = page()
        h1(col, "Создать песню")
        if (!Api.loggedIn) { note(col, "Войди, чтобы нейросеть написала для тебя песню."); col.addView(button("Войти") { show("collection") }); return }
        note(col, "Нейросеть ACE-Step сочинит музыку и споёт твой текст. Бесплатно.")
        val title = field("Название"); val artist = field("Исполнитель", Api.email?.substringBefore('@') ?: "")
        col.addView(title); col.addView(artist)
        val genre = chips(col, "Жанр", listOf("Поп" to "pop", "Рэп" to "hip-hop, rap", "Рок" to "rock, electric guitar", "Электроника" to "electronic, synth",
            "Лоу-фай" to "lo-fi, chill", "R&B" to "r&b, soul", "Танцевальная" to "dance, edm"), true)
        val mood = chips(col, "Настроение", listOf("Весёлая" to "happy, upbeat", "Грустная" to "sad, melancholic", "Энергичная" to "energetic", "Спокойная" to "calm, relaxing"), true)
        val voice = chips(col, "Голос", listOf("Мужской" to "male vocal", "Женский" to "female vocal"), false)
        val lang = chips(col, "Язык", listOf("Русский" to "ru", "English" to "en"), false)
        val len = chips(col, "Длина", listOf("30 с" to "30", "1 мин" to "60", "2 мин" to "120", "3 мин" to "180"), false, 1)
        val instrumental = CheckBox(this).apply { text = "Без слов (только музыка)"; setTextColor(Ui.TEXT) }
        col.addView(instrumental)
        val lyrics = field("[Verse]\nПервый куплет…\n\n[Chorus]\nПрипев…", multi = true)
        col.addView(lyrics)
        col.addView(button("Сгенерировать песню") {
            val t = title.text.toString().trim(); val a = artist.text.toString().trim(); val l = lyrics.text.toString().trim()
            if (t.isEmpty() || a.isEmpty()) { Ui.toast(this, "Укажи название и исполнителя"); return@button }
            if (!instrumental.isChecked && l.isEmpty()) { Ui.toast(this, "Напиши текст или включи «Без слов»"); return@button }
            val caption = (genre() + mood() + (if (instrumental.isChecked) listOf("instrumental") else voice())).joinToString(", ").ifEmpty { "pop" }
            Bg.run({ Api.requestSong(t, a, caption, l, lang().firstOrNull() ?: "ru", len().firstOrNull()?.toInt() ?: 60, instrumental.isChecked) },
                { Ui.toast(this, "Заявка принята! Песня появится в «Коллекции» через 10–30 минут"); show("collection") },
                { e -> Ui.toast(this, e.message ?: "Ошибка") })
        })
        note(col, "Запрещённые слова вырезаются из текста до генерации, а готовую песню ещё раз проверяет нейросеть.")
    }

    // ---------- Загрузить трек ----------

    private var uploadTitle: EditText? = null

    private fun upload() {
        val col = page()
        h1(col, "Загрузить трек")
        if (!Api.loggedIn) { note(col, "Чтобы загружать музыку, нужно войти."); col.addView(button("Войти") { show("collection") }); return }
        val fileLabel = Ui.text(this, pickedAudio?.let { name(it) } ?: "Файл не выбран", 15f, Ui.DIM)
        col.addView(button("Выбрать аудиофайл", accent = false) {
            startActivityForResult(Intent(Intent.ACTION_GET_CONTENT).setType("audio/*").addCategory(Intent.CATEGORY_OPENABLE), 1)
        })
        col.addView(fileLabel.apply { setPadding(0, dp(8), 0, 0) })
        val title = field("Название", pickedAudio?.let { name(it).substringBeforeLast('.') } ?: "")
        uploadTitle = title
        val artist = field("Исполнитель", Api.email?.substringBefore('@') ?: "")
        val lyrics = field("Текст песни (необязательно — найдём сами или распознаем)", multi = true)
        col.addView(title); col.addView(artist); col.addView(lyrics)
        val send = button("Отправить на проверку") {}
        send.setOnClickListener {
            val uri = pickedAudio ?: run { Ui.toast(this, "Выбери аудиофайл"); return@setOnClickListener }
            val t = title.text.toString().trim(); val a = artist.text.toString().trim()
            if (t.isEmpty() || a.isEmpty()) { Ui.toast(this, "Укажи название и исполнителя"); return@setOnClickListener }
            send.isEnabled = false; send.text = "Загрузка…"
            Bg.run({
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                if (bytes.size > 50 * 1024 * 1024) throw ApiError("Файл больше 50 МБ")
                val ext = name(uri).substringAfterLast('.', "mp3").lowercase().filter { it.isLetterOrDigit() }.ifEmpty { "mp3" }
                Api.upload(bytes, ext, contentResolver.getType(uri) ?: "audio/mpeg", t, a, lyrics.text.toString().trim())
            }, {
                pickedAudio = null
                Ui.toast(this, "Трек принят: после проверки нейросетью он появится в каталоге"); show("collection")
            }, { e -> send.isEnabled = true; send.text = "Отправить на проверку"; Ui.toast(this, e.message ?: "Ошибка") })
        }
        col.addView(send)
        note(col, "Перед публикацией нейросеть вырезает из трека мат, наркотики и суицид — на их месте остаётся бит. Загружай только то, на что у тебя есть права.")
    }

    private fun name(uri: Uri): String = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
    } ?: (uri.lastPathSegment ?: "track.mp3")

    @Deprecated("Activity API")
    override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data)
        if (result != RESULT_OK || data == null) return
        if (request == 1) { pickedAudio = data.data; show("upload") }
        if (request == 2) data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { onVoice?.invoke(it) }
    }

    @Deprecated("Activity API")
    override fun onBackPressed() {
        if (tab != "home") show("home") else moveTaskToBack(true) // музыка продолжает играть
    }
}
