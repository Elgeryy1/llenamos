"use client"

import { ArmchairIcon, MapTrifoldIcon, NoteIcon, StorefrontIcon, UserIcon } from "@phosphor-icons/react"
import type { ReactNode } from "react"
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@/components/ui/timeline"
import type { ActivityDoc } from "@/lib/data/parse"
import { formatFull, formatRelative } from "@/lib/format"

const ICONS: Record<string, ReactNode> = {
  restaurant: <StorefrontIcon aria-hidden className="size-3.5" />,
  member: <UserIcon aria-hidden className="size-3.5" />,
  table: <ArmchairIcon aria-hidden className="size-3.5" />,
  area: <MapTrifoldIcon aria-hidden className="size-3.5" />,
}

/**
 * Registro de actividad como línea de tiempo vertical (Timeline de Origin UI, MIT).
 * Ningún paso va «completado» (value 0): aquí no hay progreso, solo orden. Cada entrada: quién, qué y cuándo (relativo, con la fecha completa al pasar por encima).
 */
export function ActivityTimeline({ entries, now, label = "Actividad reciente" }: { entries: ActivityDoc[]; now: Date; label?: string }) {
  return (
    <Timeline aria-label={label} role="list" value={0}>
      {entries.map((a, i) => (
        <TimelineItem key={a.id} step={i + 1} role="listitem" className="group-data-[orientation=vertical]/timeline:ms-10 group-data-[orientation=vertical]/timeline:not-last:pb-6">
          <TimelineHeader>
            <TimelineSeparator className="bg-border group-data-[orientation=vertical]/timeline:-left-7 group-data-[orientation=vertical]/timeline:h-[calc(100%-1.5rem-0.25rem)] group-data-[orientation=vertical]/timeline:translate-y-6.5" />
            <TimelineTitle className="text-[13px] font-normal text-soft-foreground">
              <span className="font-medium text-foreground">{a.actorName ?? "El sistema"}</span> · {a.summary}
            </TimelineTitle>
            <TimelineIndicator className="flex size-6 items-center justify-center border-none bg-muted text-muted-foreground group-data-[orientation=vertical]/timeline:-left-7">
              {(a.entity && ICONS[a.entity.type]) ?? <NoteIcon aria-hidden className="size-3.5" />}
            </TimelineIndicator>
          </TimelineHeader>
          <TimelineContent>
            {a.createdAt ? (
              <TimelineDate asChild className="mt-0.5 mb-0 font-normal">
                <time dateTime={a.createdAt.toISOString()} title={formatFull(a.createdAt)}>
                  {formatRelative(a.createdAt, now)}
                </time>
              </TimelineDate>
            ) : null}
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  )
}
