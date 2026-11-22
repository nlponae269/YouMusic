package io.github.nlponae269.youmusic

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Трек из таблицы sup_tracks. */
data class Track(
    val id: String,
    val owner: String,
    val title: String,
    val artist: String,
    val album: String?,
    val duration: Int,
    val audioPath: String?,
    val coverPath: String?,
    val status: String,
    val error: String?,
) {
    /** На перепроверке нейросетью или ещё не опубликован — слушать нельзя. */
    val playable get() = status == "ready" && error != "rechecking" && audioPath != null

    companion object {
        fun from(o: JSONObject) = Track(
            id = o.getString("id"),
            owner = o.optString("owner"),
            title = o.optString("title"),
            artist = o.optString("artist"),
            album = o.optString("album").takeIf { !o.isNull("album") && it.isNotEmpty() },
            duration = o.optInt("duration"),
            audioPath = o.optString("audio_path").takeIf { !o.isNull("audio_path") && it.isNotEmpty() },
            coverPath = o.optString("cover_path").takeIf { !o.isNull("cover_path") && it.isNotEmpty() },
            status = o.optString("status", "ready"),
            error = o.optString("error").takeIf { !o.isNull("error") && it.isNotEmpty() },
        )
    }
}

class ApiError(message: String, val code: Int = 0) : Exception(message)

/**
 * Supabase через обычный REST, без библиотек. Адрес и публичный ключ берутся с сайта
 * (config.js), поэтому приложение всегда смотрит в ту же базу, что и сайт.
 */
object Api {
    private const val SITE = "https://nlponae269.github.io/YouMusic/"
    private const val COLS = "id,owner,title,artist,album,duration,audio_path,cover_path,status,error"

    var url = ""
        private set
    var key = ""
        private set
    private lateinit var prefs: SharedPreferences

    val userId get() = prefs.getString("user_id", null)
    val email get() = prefs.getString("email", null)
    val loggedIn get() = userId != null
    private val accessToken get() = prefs.getString("access", null)

    fun init(context: Context) {
        prefs = context.getSharedPreferences("supmusic", Context.MODE_PRIVATE)
        url = prefs.getString("cfg_url", "") ?: ""
        key = prefs.getString("cfg_key", "") ?: ""
    }

    /** Подтягивает адрес базы и ключ с сайта (запоминает на случай, если сайт недоступен). */
    fun loadConfig() {
        try {
            val js = String(readAll(open(SITE + "config.js?app=" + System.currentTimeMillis()).inputStream))
            val json = JSONObject(js.substring(js.indexOf('{'), js.lastIndexOf('}') + 1))
            url = json.getString("url").trimEnd('/')
            key = json.getString("key")
            prefs.edit().putString("cfg_url", url).putString("cfg_key", key).apply()
        } catch (e: Exception) {
            if (url.isEmpty()) throw ApiError("Нет связи с сервером")
        }
    }

    fun publicUrl(bucket: String, path: String) = "$url/storage/v1/object/public/$bucket/$path"
    fun audioUrl(t: Track) = publicUrl("audio", t.audioPath ?: "")
    fun coverUrl(t: Track) = t.coverPath?.let { publicUrl("covers", it) }

    // ---------- HTTP ----------

    private fun open(u: String) = (URL(u).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15000
        readTimeout = 30000
    }

    private fun readAll(s: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        s.use { it.copyTo(out) }
        return out.toByteArray()
    }

    private fun request(method: String, path: String, body: ByteArray? = null, type: String = "application/json",
                        headers: Map<String, String> = emptyMap(), auth: Boolean = true, retry: Boolean = true): String {
        val c = open(url + path)
        c.requestMethod = method
        c.setRequestProperty("apikey", key)
        val token = if (auth) accessToken else null
        c.setRequestProperty("Authorization", "Bearer " + (token ?: key))
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", type)
            c.outputStream.use { it.write(body) }
        }
        val code = c.responseCode
        val text = String(readAll(if (code < 400) c.inputStream else (c.errorStream ?: c.inputStream)))
        if (code == 401 && token != null && retry && refresh()) return request(method, path, body, type, headers, auth, false)
        if (code >= 400) {
            val msg = try { JSONObject(text).let { it.optString("msg", it.optString("message", it.optString("error_description", text))) } } catch (e: Exception) { text }
            throw ApiError(msg.ifEmpty { "Ошибка сервера ($code)" }, code)
        }
        return text
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // ---------- каталог ----------

    private fun tracks(query: String) = JSONArray(request("GET", "/rest/v1/sup_tracks?select=$COLS&$query")).let { a ->
        (0 until a.length()).map { Track.from(a.getJSONObject(it)) }
    }

    fun fresh(limit: Int = 50) = tracks("status=eq.ready&order=created_at.desc&limit=$limit")
    fun popular(limit: Int = 20) = tracks("status=eq.ready&order=plays.desc&limit=$limit")
    fun all() = tracks("status=eq.ready&order=created_at.desc&limit=300")
    fun search(q: String): List<Track> {
        val p = enc("*" + q.replace(Regex("[%,()*]"), " ").trim() + "*")
        return tracks("status=eq.ready&or=(title.ilike.$p,artist.ilike.$p)&order=created_at.desc&limit=100")
    }
    fun byIds(ids: Collection<String>) = if (ids.isEmpty()) emptyList() else tracks("status=eq.ready&id=in.(${ids.joinToString(",")})")
    fun mine() = userId?.let { tracks("owner=eq.$it&order=created_at.desc&limit=200") } ?: emptyList()

    fun lyrics(id: String): String {
        val a = JSONArray(request("GET", "/rest/v1/sup_tracks?select=lyrics&id=eq.$id"))
        return if (a.length() > 0) a.getJSONObject(0).optString("lyrics").takeIf { !a.getJSONObject(0).isNull("lyrics") } ?: "" else ""
    }

    fun countPlay(id: String) = try {
        request("POST", "/rest/v1/rpc/sup_inc_plays", JSONObject().put("track", id).toString().toByteArray())
    } catch (e: Exception) { "" }

    // ---------- лайки ----------

    fun likes(): Set<String> {
        val uid = userId ?: return emptySet()
        val a = JSONArray(request("GET", "/rest/v1/sup_likes?select=track_id&user_id=eq.$uid"))
        return (0 until a.length()).map { a.getJSONObject(it).getString("track_id") }.toSet()
    }

    fun setLike(id: String, on: Boolean) {
        val uid = userId ?: throw ApiError("Войди в аккаунт")
        if (on) request("POST", "/rest/v1/sup_likes", JSONObject().put("user_id", uid).put("track_id", id).toString().toByteArray(),
            headers = mapOf("Prefer" to "resolution=ignore-duplicates,return=minimal"))
        else request("DELETE", "/rest/v1/sup_likes?user_id=eq.$uid&track_id=eq.$id")
    }

    // ---------- аккаунт ----------

    private fun saveSession(json: String) {
        val o = JSONObject(json)
        val user = o.getJSONObject("user")
        prefs.edit()
            .putString("access", o.getString("access_token"))
            .putString("refresh", o.getString("refresh_token"))
            .putString("user_id", user.getString("id"))
            .putString("email", user.optString("email"))
            .apply()
    }

    fun signIn(email: String, password: String) {
        val body = JSONObject().put("email", email).put("password", password).toString().toByteArray()
        try {
            saveSession(request("POST", "/auth/v1/token?grant_type=password", body, auth = false))
        } catch (e: ApiError) {
            throw ApiError(if (e.message?.contains("Invalid login") == true) "Неверная почта или пароль" else e.message ?: "Ошибка входа")
        }
        ensureProfile()
    }

    fun signUp(email: String, password: String, name: String): Boolean {
        val body = JSONObject().put("email", email).put("password", password)
            .put("data", JSONObject().put("name", name)).toString().toByteArray()
        val res = JSONObject(request("POST", "/auth/v1/signup", body, auth = false))
        if (res.has("access_token")) {
            saveSession(res.toString()); ensureProfile(); return true
        }
        return false // нужно подтвердить почту
    }

    fun resetPassword(email: String) {
        request("POST", "/auth/v1/recover", JSONObject().put("email", email).put("redirect_to", SITE).toString().toByteArray(), auth = false)
    }

    private fun ensureProfile() {
        val uid = userId ?: return
        try {
            request("POST", "/rest/v1/sup_profiles", JSONObject().put("id", uid).put("name", (email ?: "user").substringBefore('@')).toString().toByteArray(),
                headers = mapOf("Prefer" to "resolution=ignore-duplicates,return=minimal"))
        } catch (e: Exception) { /* профиль уже есть */ }
    }

    private fun refresh(): Boolean {
        val rt = prefs.getString("refresh", null) ?: return false
        return try {
            saveSession(request("POST", "/auth/v1/token?grant_type=refresh_token",
                JSONObject().put("refresh_token", rt).toString().toByteArray(), auth = false, retry = false))
            true
        } catch (e: Exception) {
            signOut(); false
        }
    }

    fun signOut() {
        prefs.edit().remove("access").remove("refresh").remove("user_id").remove("email").apply()
    }

    // ---------- загрузка и генерация ----------

    /** Файл → приватный бакет sup-incoming, строка → очередь модерации (её проверит нейросеть). */
    fun upload(data: ByteArray, ext: String, mime: String, title: String, artist: String, lyrics: String?) {
        val uid = userId ?: throw ApiError("Войди в аккаунт")
        val id = java.util.UUID.randomUUID().toString()
        val path = "$uid/$id.$ext"
        request("POST", "/storage/v1/object/sup-incoming/$path", data, mime)
        val row = JSONObject().put("id", id).put("title", title).put("artist", artist).put("source_path", path)
        if (!lyrics.isNullOrBlank()) row.put("lyrics", lyrics)
        request("POST", "/rest/v1/sup_tracks", row.toString().toByteArray(), headers = mapOf("Prefer" to "return=minimal"))
    }

    /** Заявка нейросети ACE-Step: параметры — JSON-файлом, трек — в очередь. */
    fun requestSong(title: String, artist: String, caption: String, lyrics: String, language: String, duration: Int, instrumental: Boolean) {
        val uid = userId ?: throw ApiError("Войди в аккаунт")
        val id = java.util.UUID.randomUUID().toString()
        val path = "$uid/$id.gen"
        val req = JSONObject().put("caption", caption).put("lyrics", if (instrumental) "" else lyrics)
            .put("language", language).put("duration", duration).put("instrumental", instrumental)
        request("POST", "/storage/v1/object/sup-incoming/$path", req.toString().toByteArray())
        request("POST", "/rest/v1/sup_tracks", JSONObject().put("id", id).put("title", title).put("artist", artist)
            .put("source_path", path).toString().toByteArray(), headers = mapOf("Prefer" to "return=minimal"))
    }

    fun deleteTrack(t: Track) {
        request("DELETE", "/rest/v1/sup_tracks?id=eq.${t.id}")
    }
}

/** Строка текста песни: время начала и текст (пустой текст — проигрыш, показываем точки). */
data class LyricLine(val time: Double, val text: String)

object Lyrics {
    private val stamp = Regex("""\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)]""")

    /** Возвращает (строки, есть ли таймкоды). */
    fun parse(raw: String): Pair<List<LyricLine>, Boolean> {
        val lines = mutableListOf<LyricLine>()
        for (row in raw.trim().lines()) {
            val text = row.replace(Regex("""\[[^]]*]"""), "").trim().let { if (it == "♪") "" else it }
            for (m in stamp.findAll(row)) {
                lines += LyricLine(m.groupValues[1].toInt() * 60 + m.groupValues[2].replace(':', '.').toDouble(), text)
            }
        }
        if (lines.isEmpty()) return raw.trim().lines().filter { raw.isNotBlank() }.map { LyricLine(0.0, it.trim()) } to false
        lines.sortBy { it.time }
        if (lines.first().time > 4) lines.add(0, LyricLine(0.0, ""))
        return lines.filterIndexed { i, l -> l.text.isNotEmpty() || i == 0 || lines[i - 1].text.isNotEmpty() } to true
    }

    fun current(lines: List<LyricLine>, sec: Double): Int {
        var idx = -1
        for (i in lines.indices) if (lines[i].time <= sec + 0.25) idx = i else break
        return idx
    }
}
