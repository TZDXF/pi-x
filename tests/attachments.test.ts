import { describe, expect, it } from "vitest"
import { isImageAttachment, isImageUrl } from "@/lib/attachments"

describe("isImageUrl", () => {
  it("recognizes inline data URLs and remote image files", () => {
    expect(isImageUrl("data:image/png;base64,AAAA")).toBe(true)
    expect(isImageUrl("https://example.com/a/b.PNG")).toBe(true)
    expect(isImageUrl("https://example.com/a.jpeg")).toBe(true)
  })

  it("rejects non-image URLs including blob object URLs", () => {
    expect(isImageUrl("https://example.com/a.txt")).toBe(false)
    expect(isImageUrl("blob:http://localhost/7f9d2c1e-1111-2222-3333-444455556666")).toBe(false)
    expect(isImageUrl(undefined)).toBe(false)
  })
})

describe("isImageAttachment", () => {
  it("recognizes images by media type even for blob URLs", () => {
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d", mediaType: "image/png" })).toBe(true)
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d", mediaType: "IMAGE/JPEG" })).toBe(true)
  })

  it("falls back to the filename extension when media type is missing", () => {
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d", filename: "photo.webp" })).toBe(true)
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d", filename: "IMG_0001.JPG" })).toBe(true)
  })

  it("rejects non-image attachments", () => {
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d", mediaType: "text/plain", filename: "notes.txt" })).toBe(false)
    expect(isImageAttachment({ url: "blob:http://localhost/7f9d" })).toBe(false)
    expect(isImageAttachment({})).toBe(false)
  })

  it("still recognizes data and remote image URLs", () => {
    expect(isImageAttachment({ url: "data:image/gif;base64,AAAA" })).toBe(true)
    expect(isImageAttachment({ url: "https://example.com/a.png", mediaType: "application/octet-stream" })).toBe(true)
  })
})
