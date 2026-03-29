export function getCurrentWeekBounds(): {
  weekStart: string;
  weekEnd: string;
  weekStartDate: Date;
} {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    weekStart: formatDate(monday),
    weekEnd: formatDate(sunday),
    weekStartDate: monday,
  };
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
