package io.github.nlponae269.youmusic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/** Очередь и воспроизведение. Живёт в процессе приложения, экраны подписываются на изменения. */
object Player {
    interface Listener {
        fun onTrack() {}
        fun onState() {}
    }

    private val listeners = mutableSetOf<Listener>()
    private val main = Handler(Looper.getMainLooper())
    private var mp: MediaPlayer? = null
    private var prepared = false
    private lateinit var app: Context
    var queue: List<Track> = emptyList()
        private set
    var index = -1
        private set
    var shuffle = false
    var repeat = 0 // 0 — нет, 1 — вся очередь, 2 — один трек
    val current get() = queue.getOrNull(index)
    val playing get() = prepared && mp?.isPlaying == true
    val position get() = if (prepared) (mp?.currentPosition ?: 0) / 1000.0 else 0.0
    val duration get() = if (prepared) (mp?.duration ?: 0) / 1000.0 else (current?.duration ?: 0).toDouble()
    var cover: Bitmap? = null
        private set

    fun init(context: Context) { app = context.applicationContext }
    fun listen(l: Listener) { listeners += l }
    fun unlisten(l: Listener) { listeners -= l }
    private fun emitTrack() = listeners.toList().forEach { it.onTrack() }
    private fun emitState() { listeners.toList().forEach { it.onState() }; PlayerService.refresh(app) }

    /** Слушать можно только проверенные треки: на перепроверке — «временно недоступен». */
    fun play(list: List<Track>, start: Int) {
        val t = list.getOrNull(start)
        val ok = list.filter { it.playable }
        if (ok.isEmpty() || (t != null && !t.playable)) {
            Ui.toast(app, if (t?.error == "rechecking") "Трек временно недоступен — его перепроверяет нейросеть" else "Трек ещё проверяется нейросетью")
            return
        }
        queue = ok
        index = maxOf(0, ok.indexOf(t))
        load()
    }

    private fun load() {
        val t = current ?: return
        mp?.release()
        prepared = false
        cover = null
        emitTrack(); emitState()
        val player = MediaPlayer()
        mp = player
        // экран погас — музыка всё равно играет
        player.setWakeMode(app, android.os.PowerManager.PARTIAL_WAKE_LOCK)
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        player.setOnPreparedListener {
            if (mp !== it) return@setOnPreparedListener
            prepared = true
            if (requestFocus()) it.start()
            emitState()
        }
        player.setOnCompletionListener { if (mp === it) next(auto = true) }
        player.setOnErrorListener { p, _, _ -> if (mp === p) { Ui.toast(app, "Не удалось воспроизвести"); prepared = false; emitState() }; true }
        try {
            player.setDataSource(Api.audioUrl(t))
            player.prepareAsync()
        } catch (e: Exception) {
            Ui.toast(app, "Не удалось воспроизвести")
        }
        PlayerService.start(app)
        Thread { Api.countPlay(t.id) }.start()
        Api.coverUrl(t)?.let { u -> Images.load(u) { bmp -> if (current?.id == t.id) { cover = bmp; emitState() } } }
    }

    fun toggle() {
        val p = mp ?: return
        if (!prepared) return
        if (p.isPlaying) p.pause() else if (requestFocus()) p.start()
        emitState()
    }

    fun pause() { if (prepared && mp?.isPlaying == true) { mp?.pause(); emitState() } }

    fun seek(sec: Double) { if (prepared) { mp?.seekTo((sec * 1000).toInt()); emitState() } }

    fun next(auto: Boolean = false) {
        if (queue.isEmpty()) return
        if (auto && repeat == 2) { seek(0.0); mp?.start(); return }
        var i = if (shuffle && queue.size > 1) { var j: Int; do { j = (queue.indices).random() } while (j == index); j } else index + 1
        if (i >= queue.size) {
            if (repeat == 1 || !auto) i = 0 else { emitState(); return }
        }
        index = i; load()
    }

    fun prev() {
        if (position > 3 || index <= 0) { seek(0.0); return }
        index--; load()
    }

    fun setQueue(list: List<Track>, keepCurrent: Track) {
        queue = list; index = maxOf(0, list.indexOfFirst { it.id == keepCurrent.id }); emitState()
    }

    // ---------- аудиофокус: звонок или другое приложение ставят музыку на паузу ----------
    private var focus: AudioFocusRequest? = null
    private fun requestFocus(): Boolean {
        val am = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return if (Build.VERSION.SDK_INT >= 26) {
            val req = focus ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setOnAudioFocusChangeListener { change -> main.post { onFocus(change) } }.build().also { focus = it }
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus({ change -> main.post { onFocus(change) } }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) ==
                AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    private fun onFocus(change: Int) {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause()
    }
}

/** Фоновая служба: держит приложение живым, пока играет музыка, и показывает уведомление с кнопками. */
class PlayerService : Service(), Player.Listener {
    companion object {
        private const val CHANNEL = "playback"
        private const val ID = 1
        private var instance: PlayerService? = null

        fun start(context: Context) {
            val i = Intent(context, PlayerService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        }

        fun refresh(context: Context) { instance?.update() }
    }

    private lateinit var session: MediaSession

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CHANNEL, "Воспроизведение", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
        session = MediaSession(this, "supMUSIC")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = Player.toggle()
            override fun onPause() = Player.pause()
            override fun onSkipToNext() = Player.next()
            override fun onSkipToPrevious() = Player.prev()
            override fun onSeekTo(pos: Long) = Player.seek(pos / 1000.0)
        })
        session.isActive = true
        Player.listen(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "toggle" -> Player.toggle()
            "next" -> Player.next()
            "prev" -> Player.prev()
        }
        val n = build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(ID, n)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        Player.unlisten(this)
        session.release()
        instance = null
        super.onDestroy()
    }

    override fun onTrack() = update()
    override fun onState() = update()

    private fun action(name: String, icon: Int, title: String): Notification.Action {
        val pi = PendingIntent.getService(this, name.hashCode(), Intent(this, PlayerService::class.java).setAction(name),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        return Notification.Action.Builder(icon, title, pi).build()
    }

    private fun build(): Notification {
        val t = Player.current
        val open = PendingIntent.getActivity(this, 0, Intent(this, PlayerActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        b.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(t?.title ?: "supMUSIC")
            .setContentText(t?.artist ?: "")
            .setContentIntent(open)
            .setOngoing(Player.playing)
            .setShowWhen(false)
            .addAction(action("prev", android.R.drawable.ic_media_previous, "Назад"))
            .addAction(action("toggle", if (Player.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (Player.playing) "Пауза" else "Играть"))
            .addAction(action("next", android.R.drawable.ic_media_next, "Вперёд"))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
        Player.cover?.let { b.setLargeIcon(it) }
        return b.build()
    }

    fun update() {
        val t = Player.current
        session.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, t?.title ?: "")
            .putString(MediaMetadata.METADATA_KEY_ARTIST, t?.artist ?: "")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, (Player.duration * 1000).toLong())
            .also { m -> Player.cover?.let { m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) } }
            .build())
        session.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO)
            .setState(if (Player.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, (Player.position * 1000).toLong(), 1f)
            .build())
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ID, build())
        // на паузе разрешаем системе убрать уведомление смахиванием
        if (!Player.playing && Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH)
        else if (Player.playing) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(ID, build())
        }
    }
}
