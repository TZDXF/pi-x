export type ScheduleFrequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'
export const scheduleFrequencies: ScheduleFrequency[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom']
export const scheduleWeekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

export function scheduleExpression(frequency: ScheduleFrequency, time: string, weekday: string, day: number, custom: string): string {
  if (frequency === 'custom') return custom.trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid time')
  const [hour, minute] = time.split(':').map(Number)
  switch (frequency) {
    case 'hourly': return `${minute} * * * *`
    case 'daily': return `${minute} ${hour} * * *`
    case 'weekdays': return `${minute} ${hour} * * MON-FRI`
    case 'weekly':
      if (!scheduleWeekdays.some(value => value === weekday)) throw new Error('Invalid weekday')
      return `${minute} ${hour} * * ${weekday}`
    case 'monthly':
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid day')
      return `${minute} ${hour} ${day} * *`
  }
}

export function parseScheduleExpression(expression: string) {
  const result = { frequency: 'custom' as ScheduleFrequency, time: '09:00', weekday: 'MON', day: 1, custom: expression }
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return result
  const [minute, hour, day, month, weekday] = fields
  if (!/^\d+$/.test(minute) || Number(minute) > 59 || month !== '*') return result
  const validHour = /^\d+$/.test(hour) && Number(hour) < 24
  if (hour === '*' && day === '*' && weekday === '*') result.frequency = 'hourly'
  else if (!validHour) return result
  else if (day === '*' && weekday === '*') result.frequency = 'daily'
  else if (day === '*' && weekday === 'MON-FRI') result.frequency = 'weekdays'
  else if (day === '*' && scheduleWeekdays.some(value => value === weekday)) { result.frequency = 'weekly'; result.weekday = weekday }
  else if (/^\d+$/.test(day) && Number(day) >= 1 && Number(day) <= 31 && weekday === '*') { result.frequency = 'monthly'; result.day = Number(day) }
  if (result.frequency !== 'custom') result.time = `${hour === '*' ? '09' : hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  return result
}
