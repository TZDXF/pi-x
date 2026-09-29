<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()
const replay = ref(0)
// 37 cells, matching the wordmark one-to-one: every pixel participates in the morph.
const piPixels = ["011111111", "111111110", "001100110", "001100110", "001100110", "001100110", "011000111"].flatMap(
  (row, y) => [...row].flatMap((cell, x) => (cell === "1" ? [{ x: 11 + x * 2, y: 13 + y * 2 }] : [])),
)
// Grid spans x: 5-35, y: 13-27 in wordmark units; percentages keep the pixels scaling with the button.
const pixels = (
  [
    [5, 13],
    [7, 13],
    [9, 13],
    [11, 13],
    [5, 15],
    [13, 15],
    [5, 17],
    [13, 17],
    [5, 19],
    [7, 19],
    [9, 19],
    [11, 19],
    [5, 21],
    [5, 23],
    [5, 25],
    [19, 13],
    [17, 17],
    [19, 17],
    [19, 19],
    [19, 21],
    [19, 23],
    [17, 25],
    [19, 25],
    [21, 25],
    [25, 13],
    [33, 13],
    [25, 15],
    [33, 15],
    [27, 17],
    [31, 17],
    [29, 19],
    [27, 21],
    [31, 21],
    [25, 23],
    [33, 23],
    [25, 25],
    [33, 25],
  ] as const
).map(([x, y], index) => {
  const target = piPixels[index]!
  // Each pixel is 2 units square, so a translation of N units equals N/2 of its own size.
  return {
    x,
    y,
    style: {
      left: `${((x - 5) / 30) * 100}%`,
      top: `${((y - 13) / 14) * 100}%`,
      "--pi-x": `${((target.x - x) / 2) * 100}%`,
      "--pi-y": `${((target.y - y) / 2) * 100}%`,
    },
  }
})
</script>

<template>
  <button
    type="button"
    class="pix-wordmark"
    :aria-label="t('logo.reassemble')"
    @click="replay++"
  >
    <span :key="replay" class="pix-grid" :class="{ 'pix-assembling': replay > 0 }" aria-hidden="true">
      <span
        v-for="(pixel, index) in pixels"
        :key="index"
        class="pix-pixel"
        :class="{ 'pix-wordmark-accent': pixel.x >= 25 }"
        :style="pixel.style"
      />
    </span>
  </button>
</template>

<style scoped>
.pix-wordmark {
  display: inline-block;
  width: 60px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  flex-shrink: 0;
  vertical-align: middle;
  color: var(--foreground);
  --pi-color: #28765b;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.pix-grid {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.pix-pixel {
  position: absolute;
  width: calc(100% * 2 / 30);
  height: calc(100% * 2 / 14);
  background-color: var(--pixel-color, currentColor);
  pointer-events: none;
}
/* Both pseudo layers overdraw 0.5px to hide hairline seams between adjacent
   pixels at fractional device pixel ratios (e.g. Windows at 125% scale).
   They must stay off the element box itself: translate percentages resolve
   against the element size, and enlarging it would skew the morph. */
.pix-pixel::before {
  content: "";
  position: absolute;
  inset: -0.5px;
  background-color: var(--pixel-color, currentColor);
}
.pix-pixel::after {
  content: "";
  position: absolute;
  inset: -0.5px;
  background-color: var(--pi-color);
  opacity: 0;
}
.pix-wordmark:focus-visible {
  outline: 2px solid #28765b;
  outline-offset: 8px;
  border-radius: 2px;
}
.pix-wordmark-accent {
  --pixel-color: #28765b;
}
/* :global must wrap the whole selector; a bare ":global(.dark) .descendant"
   prefix compiles to just ".dark" in scoped styles. */
:global(.dark .pix-wordmark) {
  --pi-color: #9ae5c6;
}
:global(.dark .pix-wordmark-accent) {
  --pixel-color: #9ae5c6;
}
:global(.dark .pix-wordmark:focus-visible) {
  outline-color: #9ae5c6;
}
/* will-change plus transform/opacity-only keyframes keep the whole animation on
   the compositor, so it stays smooth even when the main thread is busy. */
.pix-assembling .pix-pixel {
  will-change: transform;
  animation: pixel-assemble 2000ms steps(8, end) both;
}
.pix-assembling .pix-pixel::after {
  animation: pixel-glow 2000ms steps(8, end) both;
}
@keyframes pixel-assemble {
  0% {
    transform: translate(0, 0);
  }
  30%,
  65% {
    transform: translate(var(--pi-x), var(--pi-y));
  }
  92%,
  100% {
    transform: translate(0, 0);
  }
}
@keyframes pixel-glow {
  0% {
    opacity: 0;
  }
  30%,
  65% {
    opacity: 1;
  }
  92%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pix-assembling .pix-pixel,
  .pix-assembling .pix-pixel::after {
    animation: none;
  }
}
</style>
