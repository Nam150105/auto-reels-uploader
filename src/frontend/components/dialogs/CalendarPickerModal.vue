<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" @click.self="$emit('close')">
    <div class="bg-white rounded-2xl shadow-2xl border border-slate-100 p-4 max-w-sm w-full animate-in fade-in zoom-in duration-150 select-none">
      <div class="flex gap-4">
        <!-- Left: Month / Date Picker -->
        <div class="flex-1">
          <!-- Month / Year Navigator: << < Nov 2026 > >> -->
          <div class="flex items-center justify-between pb-3 border-b border-slate-100 text-xs font-semibold text-slate-700">
            <div class="flex items-center gap-1 text-slate-400">
              <button type="button" @click="changeYear(-1)" class="p-1 hover:text-slate-700 rounded transition" title="Năm trước">
                &laquo;
              </button>
              <button type="button" @click="changeMonth(-1)" class="p-1 hover:text-slate-700 rounded transition" title="Tháng trước">
                &lsaquo;
              </button>
            </div>

            <span class="text-sm font-bold text-slate-800">{{ monthYearDisplay }}</span>

            <div class="flex items-center gap-1 text-slate-400">
              <button type="button" @click="changeMonth(1)" class="p-1 hover:text-slate-700 rounded transition" title="Tháng sau">
                &rsaquo;
              </button>
              <button type="button" @click="changeYear(1)" class="p-1 hover:text-slate-700 rounded transition" title="Năm sau">
                &raquo;
              </button>
            </div>
          </div>

          <!-- Weekday Headers -->
          <div class="grid grid-cols-7 gap-1 text-center py-2 text-[11px] font-semibold text-slate-400">
            <span v-for="w in ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']" :key="w">{{ w }}</span>
          </div>

          <!-- Calendar Days Grid -->
          <div class="grid grid-cols-7 gap-1 text-center text-xs">
            <button
              v-for="cell in calendarDays"
              :key="cell.dateStr"
              type="button"
              @click="selectDay(cell)"
              class="w-7 h-7 mx-auto rounded-lg flex items-center justify-center transition-all text-xs"
              :class="{
                'text-slate-300 pointer-events-none': cell.isOtherMonth,
                'border border-blue-600 text-blue-600 font-bold bg-blue-50/50': cell.isSelected,
                'text-slate-700 hover:bg-slate-100': !cell.isSelected && !cell.isOtherMonth,
                'font-bold text-blue-700': cell.isToday && !cell.isSelected
              }"
            >
              {{ cell.day }}
            </button>
          </div>
        </div>

        <!-- Right: Time Columns (Hours & Minutes) -->
        <div class="w-24 pl-3 border-l border-slate-100 flex flex-col">
          <div class="text-[10px] font-bold text-slate-400 uppercase text-center pb-2">
            Giờ : Phút
          </div>
          <div class="flex gap-1 h-52 overflow-hidden">
            <!-- Hours Column -->
            <div class="flex-1 overflow-y-auto pr-0.5 space-y-1 text-center scrollbar-thin">
              <button
                v-for="h in hoursList"
                :key="h"
                type="button"
                @click="selectedHour = h"
                class="w-full py-1 text-xs rounded transition text-center"
                :class="selectedHour === h ? 'bg-blue-600 text-white font-bold' : 'text-slate-600 hover:bg-slate-100'"
              >
                {{ h }}
              </button>
            </div>

            <!-- Minutes Column -->
            <div class="flex-1 overflow-y-auto pr-0.5 space-y-1 text-center scrollbar-thin">
              <button
                v-for="m in minutesList"
                :key="m"
                type="button"
                @click="selectedMinute = m"
                class="w-full py-1 text-xs rounded transition text-center"
                :class="selectedMinute === m ? 'bg-blue-600 text-white font-bold' : 'text-slate-600 hover:bg-slate-100'"
              >
                {{ m }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer: Now & OK -->
      <div class="flex items-center justify-between pt-3 mt-2 border-t border-slate-100 text-xs">
        <button
          type="button"
          @click="selectNow"
          class="text-blue-600 hover:text-blue-800 font-semibold px-2 py-1 rounded hover:bg-blue-50 transition"
        >
          Now
        </button>

        <div class="flex items-center gap-2">
          <span class="text-slate-500 font-mono text-[11px]">{{ selectedDateStr }} {{ selectedHour }}:{{ selectedMinute }}</span>
          <button
            type="button"
            @click="confirmSelection"
            class="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-sm transition"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { formatVnDate, formatVnTime, padZero } from "../../utils/date";

const props = defineProps<{
  isOpen: boolean;
  initialDate?: string;
  initialTime?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", val: { date: string; time: string }): void;
}>();

const viewYear = ref<number>(new Date().getFullYear());
const viewMonth = ref<number>(new Date().getMonth()); // 0-11
const selectedDateStr = ref<string>(props.initialDate || formatVnDate());
const selectedHour = ref<string>(props.initialTime ? props.initialTime.split(":")[0] : "08");
const selectedMinute = ref<string>(props.initialTime ? props.initialTime.split(":")[1] : "00");

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      if (props.initialDate) {
        selectedDateStr.value = props.initialDate;
        const [y, m] = props.initialDate.split("-").map(Number);
        if (y && m) {
          viewYear.value = y;
          viewMonth.value = m - 1;
        }
      }
      if (props.initialTime) {
        const [h, min] = props.initialTime.split(":");
        selectedHour.value = h || "08";
        selectedMinute.value = min || "00";
      }
    }
  }
);

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const monthYearDisplay = computed(() => {
  return `${months[viewMonth.value]} ${viewYear.value}`;
});

const hoursList = Array.from({ length: 24 }, (_, i) => padZero(i));
const minutesList = Array.from({ length: 60 }, (_, i) => padZero(i));

interface DayCell {
  day: number;
  dateStr: string;
  isOtherMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
}

const calendarDays = computed(() => {
  const y = viewYear.value;
  const m = viewMonth.value;

  const firstDayOfWeek = new Date(y, m, 1).getDay(); // 0 is Sunday
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();

  const cells: DayCell[] = [];
  const todayStr = formatVnDate();

  // Previous month trailing days
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    const prevM = m === 0 ? 12 : m;
    const prevY = m === 0 ? y - 1 : y;
    const dStr = `${prevY}-${padZero(prevM)}-${padZero(day)}`;
    cells.push({
      day,
      dateStr: dStr,
      isOtherMonth: true,
      isSelected: false,
      isToday: false
    });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = `${y}-${padZero(m + 1)}-${padZero(d)}`;
    cells.push({
      day: d,
      dateStr: dStr,
      isOtherMonth: false,
      isSelected: dStr === selectedDateStr.value,
      isToday: dStr === todayStr
    });
  }

  // Next month leading days to complete grid (42 cells: 6 rows of 7)
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    const nextM = m === 11 ? 1 : m + 2;
    const nextY = m === 11 ? y + 1 : y;
    const dStr = `${nextY}-${padZero(nextM)}-${padZero(d)}`;
    cells.push({
      day: d,
      dateStr: dStr,
      isOtherMonth: true,
      isSelected: false,
      isToday: false
    });
  }

  return cells;
});

const changeMonth = (delta: number) => {
  let nm = viewMonth.value + delta;
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

const changeYear = (delta: number) => {
  viewYear.value += delta;
};

const selectDay = (cell: DayCell) => {
  if (cell.isOtherMonth) return;
  selectedDateStr.value = cell.dateStr;
};

const selectNow = () => {
  const now = new Date();
  selectedDateStr.value = formatVnDate(now);
  selectedHour.value = formatVnTime(now).split(":")[0];
  selectedMinute.value = formatVnTime(now).split(":")[1];
  viewYear.value = now.getFullYear();
  viewMonth.value = now.getMonth();
};

const confirmSelection = () => {
  emit("confirm", {
    date: selectedDateStr.value,
    time: `${selectedHour.value}:${selectedMinute.value}`
  });
  emit("close");
};
</script>
