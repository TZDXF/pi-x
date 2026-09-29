<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()
const replay = ref(0)
// 37 cells, matching the wordmark one-to-one: every pixel participates in the morph.
const piPixels = ["011111111", "111111110", "001100110", "001100110", "001100110", "001100110", "011000111"].flatMap(
  (row, y) => [...row].flatMap((cell, x) => (cell === "1" ? [{ x: 11 + x * 2, y: 13 + y * 2 }] : [])),
)
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
  return {
    x,
    y,
    style: {
      "--pi-x": `${target.x - x}px`,
      "--pi-y": `${target.y - y}px`,
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
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="5 13 30 14"
      width="60"
      height="28"
      aria-hidden="true"
      shape-rendering="crispEdges"
    >
      <g :key="replay" :class="{ 'pix-assembling': replay > 0 }">
        <rect
          v-for="(pixel, index) in pixels"
          :key="index"
          :x="pixel.x"
          :y="pixel.y"
          width="2"
          height="2"
          fill="currentColor"
          :class="{ 'pix-wordmark-accent': pixel.x >= 25 }"
          :style="pixel.style"
        />
      </g>
    </svg>
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
.pix-wordmark svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.pix-wordmark:focus-visible {
  outline: 2px solid #28765b;
  outline-offset: 8px;
  border-radius: 2px;
}
.pix-wordmark-accent {
  --pixel-color: #28765b;
  fill: var(--pixel-color);
}
:global(.dark) .pix-wordmark {
  --pi-color: #9ae5c6;
}
:global(.dark) .pix-wordmark-accent {
  --pixel-color: #9ae5c6;
}
:global(.dark) .pix-wordmark:focus-visible {
  outline-color: #9ae5c6;
}
.pix-assembling rect {
  transform-box: fill-box;
  transform-origin: center;
  animation: pixel-assemble 2000ms steps(8, end) both;
}
@keyframes pixel-assemble {
  0% {
    transform: translate(0, 0);
    fill: var(--pixel-color, currentColor);
  }
  30%,
  65% {
    transform: translate(var(--pi-x), var(--pi-y));
    fill: var(--pi-color);
  }
  92%,
  100% {
    transform: translate(0, 0);
    fill: var(--pixel-color, currentColor);
  }
}
@media (prefers-reduced-motion: reduce) {
  .pix-assembling rect {
    animation: none;
  }
}
</style>
