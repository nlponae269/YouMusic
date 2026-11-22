package io.github.nlponae269.youmusic

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/**
 * Значки рисуются кодом по контурам 24×24 (как SVG): буква — команда, дальше числа.
 * Поддерживаются M L H V C Z (заглавные — абсолютные координаты) и O x y r — окружность.
 * Контур, начинающийся с «!», заливается; остальные — линии.
 */
class Icon(context: Context, kind: String, var color: Int = Color.WHITE) : View(context) {
    private val shapes = mutableListOf<Pair<Path, Boolean>>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val m = Matrix()
    private val tmp = Path()

    var kind: String = ""
        set(value) {
            field = value
            shapes.clear()
            for (part in (ICONS[value] ?: "").split('|')) {
                val fill = part.startsWith("!")
                shapes += parse(part.removePrefix("!")) to fill
            }
            invalidate()
        }

    init { this.kind = kind }

    override fun onDraw(canvas: Canvas) {
        val size = minOf(width, height).toFloat()
        val scale = size / 24f
        m.reset()
        m.setScale(scale, scale)
        m.postTranslate((width - size) / 2, (height - size) / 2)
        paint.color = color
        paint.strokeWidth = 2.1f * scale
        for ((p, fill) in shapes) {
            tmp.set(p); tmp.transform(m)
            paint.style = if (fill) Paint.Style.FILL else Paint.Style.STROKE
            canvas.drawPath(tmp, paint)
        }
    }

    companion object {
        val ICONS = mapOf(
            "play" to "!M8 5 L8 19 L19 12 Z",
            "pause" to "!M6 5 L10 5 L10 19 L6 19 Z M14 5 L18 5 L18 19 L14 19 Z",
            "next" to "!M5 6 L5 18 L14 12 Z M16 6 L18.5 6 L18.5 18 L16 18 Z",
            "prev" to "!M19 6 L19 18 L10 12 Z M5.5 6 L8 6 L8 18 L5.5 18 Z",
            "heart" to "M12 20 C5 14.5 2.5 11.5 2.5 8.5 C2.5 5.8 4.6 3.8 7.3 3.8 C9.2 3.8 11 5 12 6.6 C13 5 14.8 3.8 16.7 3.8 C19.4 3.8 21.5 5.8 21.5 8.5 C21.5 11.5 19 14.5 12 20 Z",
            "heart-on" to "!M12 20 C5 14.5 2.5 11.5 2.5 8.5 C2.5 5.8 4.6 3.8 7.3 3.8 C9.2 3.8 11 5 12 6.6 C13 5 14.8 3.8 16.7 3.8 C19.4 3.8 21.5 5.8 21.5 8.5 C21.5 11.5 19 14.5 12 20 Z",
            "shuffle" to "M3 7 L7 7 L17 17 L21 17 M3 17 L7 17 L17 7 L21 7 M18 4 L21 7 L18 10 M18 14 L21 17 L18 20",
            "repeat" to "M4 12 L4 8 L18 8 M15 5 L18 8 L15 11 M20 12 L20 16 L6 16 M9 19 L6 16 L9 13",
            "lyrics" to "M4 6 L20 6 M4 11 L14 11 M4 16 L20 16 M4 21 L11 21",
            "down" to "M5 9 L12 16 L19 9",
            "expand" to "M14 4 L20 4 L20 10 M20 4 L14 10 M10 20 L4 20 L4 14 M4 20 L10 14",
            "search" to "O10.5 10.5 6.5 M15.5 15.5 L20.5 20.5",
            "mic" to "M9 6 L9 11 C9 13 10.3 14 12 14 C13.7 14 15 13 15 11 L15 6 C15 4 13.7 3 12 3 C10.3 3 9 4 9 6 Z M5.5 11 C5.5 15 8.5 17.5 12 17.5 C15.5 17.5 18.5 15 18.5 11 M12 17.5 L12 21",
            "home" to "!M3 11 L12 3 L21 11 L21 21 L15 21 L15 15 L9 15 L9 21 L3 21 Z",
            "library" to "M9 18 L9 5 L20 3 L20 16 O6.5 18 2.5 O17.5 16 2.5",
            "plus" to "M12 5 L12 19 M5 12 L19 12",
            "upload" to "M12 16 L12 4 M7 9 L12 4 L17 9 M5 20 L19 20",
            "spark" to "!M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z",
            "download" to "M12 4 L12 16 M7 11 L12 16 L17 11 M5 20 L19 20",
            "share" to "M12 15 L12 4 M7 9 L12 4 L17 9 M5 12 L5 20 L19 20 L19 12",
            "trash" to "M5 7 L19 7 M10 7 L10 4 L14 4 L14 7 M7 7 L8 20 L16 20 L17 7",
            "close" to "M6 6 L18 18 M18 6 L6 18",
        )

        private fun parse(d: String): Path {
            val p = Path()
            val tokens = Regex("[A-Za-z]|-?\\d*\\.?\\d+").findAll(d).map { it.value }.toList()
            var i = 0
            var cmd = 'M'
            var x = 0f
            var y = 0f
            fun num() = tokens[i++].toFloat()
            while (i < tokens.size) {
                val t = tokens[i]
                if (t[0].isLetter()) { cmd = t[0]; i++; if (cmd == 'Z') { p.close(); continue } }
                when (cmd) {
                    'M' -> { x = num(); y = num(); p.moveTo(x, y); cmd = 'L' }
                    'L' -> { x = num(); y = num(); p.lineTo(x, y) }
                    'H' -> { x = num(); p.lineTo(x, y) }
                    'V' -> { y = num(); p.lineTo(x, y) }
                    'C' -> { val a = num(); val b = num(); val c = num(); val e = num(); x = num(); y = num(); p.cubicTo(a, b, c, e, x, y) }
                    'O' -> { val cx = num(); val cy = num(); val r = num(); p.addCircle(cx, cy, r, Path.Direction.CW) }
                    else -> i++
                }
            }
            return p
        }
    }
}
