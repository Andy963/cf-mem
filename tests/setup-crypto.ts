import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

const subtle = globalThis.crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => boolean;
};

if (typeof subtle.timingSafeEqual !== "function") {
  Object.defineProperty(subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean => {
      const leftBytes = left instanceof ArrayBuffer
        ? new Uint8Array(left)
        : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
      const rightBytes = right instanceof ArrayBuffer
        ? new Uint8Array(right)
        : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
      return leftBytes.byteLength === rightBytes.byteLength
        && nodeTimingSafeEqual(leftBytes, rightBytes);
    },
  });
}
