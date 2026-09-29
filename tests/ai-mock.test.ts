import { useAimock } from "@copilotkit/aimock/vitest"
import { test, expect } from "vitest"

// This local AI mock is the deterministic entry point for future frontend
// AI/provider requests. It only serves repository fixtures and never reaches
// the network or a real model.
const getAi = useAimock({ fixtures: "tests/fixtures/ai" })

function parseSseData(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .flatMap(block =>
      block
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice("data:".length).trim()),
    )
    .filter(Boolean)
}

function reassembleToolCalls(events) {
  const calls = new Map()

  for (const event of events) {
    if (event === "[DONE]") continue
    const parsed = JSON.parse(event)
    for (const toolCall of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
      const key = toolCall.index ?? toolCall.id ?? 0
      const current = calls.get(key) ?? { name: "", arguments: "" }
      calls.set(key, {
        name: toolCall.function?.name ?? current.name,
        arguments: current.arguments + (toolCall.function?.arguments ?? ""),
      })
    }
  }

  return [...calls.values()]
}

test("chat completions returns deterministic hello text without streaming", async () => {
  const response = await fetch(`${getAi().url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "pix-test-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.ok).toBe(true)
  const completion = await response.json()
  expect(completion.choices[0].message.content).toBe("Hi there!")
})

test("streaming weather response reassembles the get_weather tool call", async () => {
  const response = await fetch(`${getAi().url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "pix-test-model",
      messages: [{ role: "user", content: "weather" }],
      stream: true,
    }),
  })

  expect(response.ok).toBe(true)
  expect(response.headers.get("content-type")).toContain("text/event-stream")

  let raw = ""
  for await (const chunk of response.body) raw += new TextDecoder().decode(chunk)

  const toolCalls = reassembleToolCalls(parseSseData(raw))
  const weatherCall = toolCalls.find(call => call.name === "get_weather")
  expect(weatherCall).toBeDefined()
  expect(JSON.parse(weatherCall.arguments)).toEqual({ city: "SF" })
  expect(raw).toContain("data: [DONE]")
})
