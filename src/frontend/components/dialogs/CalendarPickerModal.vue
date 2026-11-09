<template>
  <div
    v-if="isOpen"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
    @click.self="$emit('close')"
  >
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 p-4 max-w-sm w-full animate-in fade-in zoom-in duration-150 select-none">
      <div class="flex gap-4">
        <!-- Left: Month / Date Picker -->
        <div class="flex-1">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100 text-xs font-semibold text-slate-700">
            <button
              type="button"
              @click="changeMonth(-1)"
              :disabled="!canGoPrevMonth"
              class="p-1 rounded transition text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:pointer-events-none"
              title="Previous month"
            >
              &lsaquo;
            </button>
            <span class="text-sm font-bold text-slate-800">{{ monthYearDisplay }}</span>
            <button
              type="button"
              @click="changeMonth(1)"
              class="p-1 rounded transition text-slate-400 hover:text-slate-700"
              title="Next month"
            >
              &rsaquo;
            </button>
          </div>

          <div class="grid grid-cols-7 gap-1 text-center py-2 text-[11px] font-semibold text-slate-400">
            <span v-for="w in weekdays" :key="w">{{ w }}</span>
          </div>

          <div class="grid grid-cols-7 gap-1 text-center text-xs">
            <button
              v-for="cell in calendarDays"
              :key="cell.dateStr"
              type="button"
              :disabled="cell.isOtherMonth || cell.isDisabled"
              @click="selectDay(cell)"
              class="w-7 h-7 mx-auto rounded-lg flex items-center justify-center transition-all text-xs"
              :class="{
                'invisible': cell.isOtherMonth,
                'text-slate-300 line-through decoration-slate-200 cursor-not-allowed': !cell.isOtherMonth && cell.isDisabled,
                'bg-blue-600 text-white font-bold': cell.isSelected,
                'text-slate-700 hover:bg-slate-100': !cell.isSelected && !cell.isDisabled && !cell.isOtherMonth,
                'ring-1 ring-blue-300 font-bold text-blue-700': cell.isToday && !cell.isSelected && !cell.isDisabled
              }"
            >
              {{ cell.day }}
            </button>
          </div>
        </div>

        <!-- Right: Time Columns -->
        <div class="w-24 pl-3 border-l border-slate-100 flex flex-col">
          <div class="text-[10px] font-bold text-slate-400 uppercase text-center pb-2">Hour : Min</div>
          <div class="flex gap-1 h-52 overflow-hidden">
            <div ref="hourColRef" class="flex-1 overflow-y-auto pr-0.5 space-y-1 text-center scrollbar-thin">
              <button
                v-for="h in hoursList"
                :key="h"
                type="button"
                :data-value="h"
                :disabled="isHourDisabled(h)"
                @click="selectHour(h)"
                class="w-full py-1 text-xs rounded transition text-center"
                :class="
                  selectedHour === h
                    ? 'bg-blue-600 text-white font-bold'
                    : isHourDisabled(h)
                      ? 'text-slate-300 cursor-not-allowed'
                      : 'text-slate-600 hover:bg-slate-100'
                "
              >
                {{ h }}
              </button>
            </div>
            <div ref="minuteColRef" class="flex-1 overflow-y-auto pr-0.5 space-y-1 text-center scrollbar-thin">
              <button
                v-for="m in minutesList"
                :key="m"
                type="button"
                :data-value="m"
                :disabled="isMinuteDisabled(m)"
                @click="selectedMinute = m"
                class="w-full py-1 text-xs rounded transition text-center"
                :class="
                  selectedMinute === m
                    ? 'bg-blue-600 text-white font-bold'
                    : isMinuteDisabled(m)
                      ? 'text-slate-300 cursor-not-allowed'
                      : 'text-slate-600 hover:bg-slate-100'
                "
              >
                {{ m }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p class="mt-3 text-[11px] text-slate-500 bg-slate-50/80 rounded-xl px-2.5 py-1.5 border border-slate-200/60">
        Thời điểm sớm nhất có thể: <strong class="text-blue-700 font-bold">{{ earliestDisplay }}</strong> (cách hiện tại ít nhất {{ leadMinutes }} phút).
      </p>

      <div class="flex items-center justify-between pt-3 mt-2 border-t border-slate-100 text-xs">
        <button
          type="button"
          @click="selectEarliest"
          class="text-blue-600 hover:text-blue-800 font-bold px-2 py-1 rounded-lg hover:bg-blue-50 transition"
        >
          Sớm nhất
        </button>
        <div class="flex items-center gap-2">
          <span class="text-slate-700 font-bold font-mono text-[11px] bg-slate-100 px-2 py-0.5 rounded-md">{{ selectionDisplay }}</span>
          <button
            type="button"
            @click="confirmSelection"
            class="px-3.5 py-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold rounded-lg shadow-2xs transition"
          >
            Xác nhận
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import {
  padZero,
  getEarliestScheduleSlot,
  isScheduleSlotAllowed,
  MIN_SCHEDULE_LEAD_MINUTES
} from "../../utils/date";

const props = withDefaults(
  defineProps<{
    isOpen: boolean;
    initialDate?: string;
    initialTime?: string;
    minLeadMinutes?: number;
  }>(),
  { minLeadMinutes: MIN_SCHEDULE_LEAD_MINUTES }
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", val: { date: string; time: string }): void;
}>();

const leadMinutes = computed(() => props.minLeadMinutes);
const weekdays = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const monthNames = [
  "Tháng 1",
  "Tháng 2",
  "Tháng 3",
  "Tháng 4",
  "Tháng 5",
  "Tháng 6",
  "Tháng 7",
  "Tháng 8",
  "Tháng 9",
  "Tháng 10",
  "Tháng 11",
  "Tháng 12"
];
const hoursList = Array.from({ length: 24 }, (_, i) => padZero(i));
const minutesList = Array.from({ length: 60 }, (_, i) => padZero(i));

// Recompute the earliest slot periodically while open so past cells lock in real time
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
const earliest = computed(() => {
  void tick.value;
  return getEarliestScheduleSlot(leadMinutes.value);
});
const earliestHour = computed(() => earliest.value.time.split(":")[0]);
const earliestMinute = computed(() => earliest.value.time.split(":")[1]);

const selectedDateStr = ref<string>(earliest.value.date);
const selectedHour = ref<string>(earliestHour.value);
const selectedMinute = ref<string>(earliestMinute.value);
const viewYear = ref<number>(Number(earliest.value.date.slice(0, 4)));
const viewMonth = ref<number>(Number(earliest.value.date.slice(5, 7)) - 1);

const hourColRef = ref<HTMLElement | null>(null);
const minuteColRef = ref<HTMLElement | null>(null);

const formatDisplay = (date: string, time: string) => {
  const [y, m, d] = date.split("-");
  return `${time} ${d}/${m}/${y}`;
};
const earliestDisplay = computed(() => formatDisplay(earliest.value.date, earliest.value.time));
const selectionDisplay = computed(() =>
  formatDisplay(selectedDateStr.value, `${selectedHour.value}:${selectedMinute.value}`)
);

const isHourDisabled = (h: string) =>
  selectedDateStr.value < earliest.value.date ||
  (selectedDateStr.value === earliest.value.date && h < earliestHour.value);

const isMinuteDisabled = (m: string) =>
  isHourDisabled(selectedHour.value) ||
  (selectedDateStr.value === earliest.value.date &&
    selectedHour.value === earliestHour.value &&
    m < earliestMinute.value);

/** Move the selection to the nearest valid slot if it falls in the past */
const clampSelection = () => {
  const e = earliest.value;
  if (selectedDateStr.value < e.date) {
    selectedDateStr.value = e.date;
  }
  if (selectedDateStr.value === e.date) {
    if (selectedHour.value < earliestHour.value) {
      selectedHour.value = earliestHour.value;
      selectedMinute.value = earliestMinute.value;
    } else if (selectedHour.value === earliestHour.value && selectedMinute.value < earliestMinute.value) {
      selectedMinute.value = earliestMinute.value;
    }
  }
};

const scrollToSelected = () => {
  nextTick(() => {
    for (const [col, val] of [
      [hourColRef.value, selectedHour.value],
      [minuteColRef.value, selectedMinute.value]
    ] as const) {
      const el = col?.querySelector<HTMLElement>(`[data-value="${val}"]`);
      if (col && el) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.clientHeight / 2;
    }
  });
};

watch(
  () => props.isOpen,
  (open) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!open) return;
    tick.value++;
    timer = setInterval(() => tick.value++, 15000);

    const initDate = props.initialDate || "";
    const initTime = props.initialTime || "";
    if (initDate && initTime && isScheduleSlotAllowed(initDate, initTime, leadMinutes.value)) {
      selectedDateStr.value = initDate;
      selectedHour.value = initTime.split(":")[0] || earliestHour.value;
      selectedMinute.value = initTime.split(":")[1] || earliestMinute.value;
    } else {
      selectedDateStr.value = earliest.value.date;
      selectedHour.value = earliestHour.value;
      selectedMinute.value = earliestMinute.value;
    }
    viewYear.value = Number(selectedDateStr.value.slice(0, 4));
    viewMonth.value = Number(selectedDateStr.value.slice(5, 7)) - 1;
    scrollToSelected();
  },
  { immediate: true }
);

// As time passes while open, push the selection forward to a valid slot
watch(earliest, clampSelection);

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const monthYearDisplay = computed(() => `${monthNames[viewMonth.value]} ${viewYear.value}`);

const canGoPrevMonth = computed(() => {
  const ey = Number(earliest.value.date.slice(0, 4));
  const em = Number(earliest.value.date.slice(5, 7)) - 1;
  return viewYear.value > ey || (viewYear.value === ey && viewMonth.value > em);
});

interface DayCell {
  day: number;
  dateStr: string;
  isOtherMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  isDisabled: boolean;
}

const calendarDays = computed<DayCell[]>(() => {
  const y = viewYear.value;
  const m = viewMonth.value;
  // Compute the weekday in UTC so it doesn't depend on the browser's time zone
  const firstDayOfWeek = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const todayStr = getEarliestScheduleSlot(0).date;
  const cells: DayCell[] = [];

  for (let i = 0; i < firstDayOfWeek; i++) {
    cells.push({ day: 0, dateStr: `prev-${i}`, isOtherMonth: true, isSelected: false, isToday: false, isDisabled: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = `${y}-${padZero(m + 1)}-${padZero(d)}`;
    cells.push({
      day: d,
      dateStr: dStr,
      isOtherMonth: false,
      isSelected: dStr === selectedDateStr.value,
      isToday: dStr === todayStr,
      isDisabled: dStr < earliest.value.date
    });
  }
  return cells;
});

const changeMonth = (delta: number) => {
  if (delta < 0 && !canGoPrevMonth.value) return;
  const nm = viewMonth.value + delta;
  if (nm > 11) {
    viewMonth.value = 0;
    viewYear.value += 1;
  } else if (nm < 0) {
    viewMonth.value = 11;
    viewYear.value -= 1;
  } else {
    viewMonth.value = nm;
  }
};

const selectDay = (cell: DayCell) => {
  if (cell.isOtherMonth || cell.isDisabled) return;
  selectedDateStr.value = cell.dateStr;
  clampSelection();
  scrollToSelected();
};

const selectHour = (h: string) => {
  if (isHourDisabled(h)) return;
  selectedHour.value = h;
  clampSelection();
};

const selectEarliest = () => {
  tick.value++;
  selectedDateStr.value = earliest.value.date;
  selectedHour.value = earliestHour.value;
  selectedMinute.value = earliestMinute.value;
  viewYear.value = Number(earliest.value.date.slice(0, 4));
  viewMonth.value = Number(earliest.value.date.slice(5, 7)) - 1;
  scrollToSelected();
};

const confirmSelection = () => {
  tick.value++;
  clampSelection();
  emit("confirm", {
    date: selectedDateStr.value,
    time: `${selectedHour.value}:${selectedMinute.value}`
  });
  emit("close");
};
</script>
