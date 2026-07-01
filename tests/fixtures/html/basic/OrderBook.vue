<script setup lang="ts">
import { ref } from 'vue';
import { listOrders, cancelOrder, openDialog } from '../api/client';

const orders = ref([]);

async function refresh() {
  orders.value = await listOrders();
}

async function handleCancel(id: string) {
  await cancelOrder(id);
  await refresh();
}

const reloadLater = () =>
  refresh();

// Method with a TS object return-type annotation. The body harvester
// has to skip past `{ count: number }` and find the real body brace,
// or it would extract `count: number` as the body and miss `summarize()`.
function tallyOrders(): { count: number } {
  return summarize();
}

// Arrow function with an object default value in params. The brace
// finder has to skip the `{ size: 10 }` default and resolve only the
// `=>` body. Without this, the default literal would shadow the
// real body.
const openWithDefault = (opts = { size: 10 }) => openDialog(opts);

// Method body containing a regex literal with a brace inside. A naive
// brace counter sees the `}` in `/^\}+/` and decrements depth, which
// would truncate this body and cascade `}` underflow into the next
// method's extraction. The walker must recognise `/.../` as a literal
// in expression position and skip past it.
function validateInput(s: string) {
  if (/^\}+/.test(s)) return false;
  return doValidate(s);
}

// Sentinel — must extract independently from `validateInput`. If the
// regex skip is broken, this method's snippet would either be empty
// or get mis-attributed to whatever brace `validateInput` underflowed.
function nextAfterRegex() {
  return sentinelCall();
}

// Function expression bound to a const, with a TS return-type
// annotation. Exercises the Pattern 3 `function` branch +
// `findOpenBraceAfterParams` return-type probe — a different code
// path from the `function` declaration form.
const tallyFromExpr = function (): { count: number } {
  return summarizeAgain();
};

// Arrow with an expression body containing a string literal that
// itself contains a `;`. The naive `findExprBodyEnd` would stop at
// the `;` inside the string and lose `formatLabel`. Skip-strings
// keeps the body intact.
const greet = (name: string) => formatLabel(`hi;${name}`);

// Multi-line arrow whose body opens with a line comment. The body
// finder must skip the comment AND not treat its non-whitespace
// chars as "expression started" — otherwise the newline at end of
// comment terminates the slice before `replyTo` is captured.
const handleNote = (n: string) =>
  // explain what we're doing
  replyTo(n);
</script>

<template>
  <button @click="handleCancel('x')">Cancel</button>
  <button @click="refresh">Refresh</button>
  <button @click="reloadLater">Reload</button>
  <button @click="tallyOrders">Tally</button>
  <button @click="openWithDefault">Open</button>
  <button @click="validateInput">Validate</button>
  <button @click="nextAfterRegex">Sentinel</button>
</template>
