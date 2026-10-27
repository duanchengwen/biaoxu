import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';

export type FloatingToolbarActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success' | 'ai';

export interface FloatingToolbarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tooltip?: string;
  disabled?: boolean;
  variant?: FloatingToolbarActionVariant;
  className?: string;
  onClick: () => void;
}

export interface FloatingToolbarGroup {
  id: string;
  actions: FloatingToolbarAction[];
}

interface FloatingToolbarProps {
  groups: FloatingToolbarGroup[];
  label?: string;
}

interface FloatingToolbarPosition {
  left: number;
  top: number;
  maxWidth: number;
}

interface FloatingToolbarDragState {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  activated: boolean;
}

const FLOATING_TOOLBAR_GUTTER = 8;
const FLOATING_TOOLBAR_DRAG_THRESHOLD = 3;

function isSamePosition(current: FloatingToolbarPosition, next: FloatingToolbarPosition) {
  return Math.abs(current.left - next.left) < 0.5
    && Math.abs(current.top - next.top) < 0.5
    && Math.abs(current.maxWidth - next.maxWidth) < 0.5;
}

function FloatingToolbar({ groups, label = '页面工具条' }: FloatingToolbarProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<FloatingToolbarDragState | null>(null);
  const previousLayoutKeyRef = useRef('');
  const [position, setPosition] = useState<FloatingToolbarPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const visibleGroups = groups.filter((group) => group.actions.length > 0);
  const layoutKey = useMemo(
    () => visibleGroups.map((group) => `${group.id}:${group.actions.map((action) => action.id).join(',')}`).join('|'),
    [visibleGroups],
  );

  const getWorkspaceRect = useCallback(() => {
    const workspace = dockRef.current?.closest('.content-shell');
    const rect = workspace?.getBoundingClientRect();

    return {
      left: Math.max(0, rect?.left ?? 0),
      top: Math.max(0, rect?.top ?? 0),
      right: Math.min(window.innerWidth, rect?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
    };
  }, []);

  const clampPosition = useCallback((left: number, top: number): FloatingToolbarPosition => {
    const toolbarRect = toolbarRef.current?.getBoundingClientRect();
    const workspaceRect = getWorkspaceRect();
    const maxWidth = Math.max(80, workspaceRect.right - workspaceRect.left - FLOATING_TOOLBAR_GUTTER * 2);
    const toolbarWidth = Math.min(toolbarRect?.width ?? maxWidth, maxWidth);
    const toolbarHeight = toolbarRect?.height ?? 42;
    const minLeft = workspaceRect.left + FLOATING_TOOLBAR_GUTTER;
    const minTop = workspaceRect.top + FLOATING_TOOLBAR_GUTTER;
    const maxLeft = Math.max(minLeft, workspaceRect.right - toolbarWidth - FLOATING_TOOLBAR_GUTTER);
    const maxTop = Math.max(minTop, workspaceRect.bottom - toolbarHeight - FLOATING_TOOLBAR_GUTTER);

    return {
      left: Math.min(Math.max(minLeft, left), maxLeft),
      top: Math.min(Math.max(minTop, top), maxTop),
      maxWidth,
    };
  }, [getWorkspaceRect]);

  const resetPosition = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
    setPosition(null);
  }, []);

  useEffect(() => {
    if (previousLayoutKeyRef.current && previousLayoutKeyRef.current !== layoutKey) {
      resetPosition();
    }
    previousLayoutKeyRef.current = layoutKey;
  }, [layoutKey, resetPosition]);

  useEffect(() => {
    if (!position) {
      return undefined;
    }

    let animationFrame = 0;
    const keepInWorkspace = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        setPosition((current) => {
          if (!current) return null;
          const next = clampPosition(current.left, current.top);
          return isSamePosition(current, next) ? current : next;
        });
      });
    };
    const resizeObserver = new ResizeObserver(keepInWorkspace);
    const workspace = dockRef.current?.closest('.content-shell');
    if (workspace) {
      resizeObserver.observe(workspace);
    }
    if (toolbarRef.current) {
      resizeObserver.observe(toolbarRef.current);
    }
    window.addEventListener('resize', keepInWorkspace);
    window.visualViewport?.addEventListener('resize', keepInWorkspace);
    // Electron 的页面缩放并不总会同步触发 window/ResizeObserver；浮动态下低频复核一次边界。
    const boundaryCheck = window.setInterval(keepInWorkspace, 160);
    keepInWorkspace();

    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearInterval(boundaryCheck);
      resizeObserver.disconnect();
      window.removeEventListener('resize', keepInWorkspace);
      window.visualViewport?.removeEventListener('resize', keepInWorkspace);
    };
  }, [clampPosition, position !== null]);

  // 缩放或侧栏变化会先改变可用宽度，再改变卡片实际高度；布局完成后再钳位一遍。
  useLayoutEffect(() => {
    if (!position) return;
    const next = clampPosition(position.left, position.top);
    if (!isSamePosition(position, next)) {
      setPosition(next);
    }
  }, [clampPosition, position]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const toolbarRect = toolbarRef.current?.getBoundingClientRect();
    if (!toolbarRect) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: position?.left ?? toolbarRect.left,
      top: position?.top ?? toolbarRect.top,
      activated: Boolean(position),
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const drag = (event: PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.activated && Math.hypot(deltaX, deltaY) < FLOATING_TOOLBAR_DRAG_THRESHOLD) {
      return;
    }

    dragState.activated = true;
    setPosition(clampPosition(dragState.left + deltaX, dragState.top + deltaY));
  };

  const stopDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' || event.key === 'Home') {
      resetPosition();
      event.preventDefault();
      return;
    }

    const direction = {
      ArrowLeft: [-12, 0],
      ArrowRight: [12, 0],
      ArrowUp: [0, -12],
      ArrowDown: [0, 12],
    }[event.key];
    if (!direction) {
      return;
    }

    const toolbarRect = toolbarRef.current?.getBoundingClientRect();
    if (!toolbarRect) {
      return;
    }
    setPosition(clampPosition(
      (position?.left ?? toolbarRect.left) + direction[0],
      (position?.top ?? toolbarRect.top) + direction[1],
    ));
    event.preventDefault();
  };

  if (visibleGroups.length === 0) {
    return null;
  }

  return (
    <div className="floating-toolbar-dock" ref={dockRef}>
      <div
        className={`floating-toolbar${position ? ' is-floating' : ''}${dragging ? ' is-dragging' : ''}`}
        role="toolbar"
        aria-label={label}
        ref={toolbarRef}
        style={position ? {
          left: position.left,
          top: position.top,
          maxWidth: position.maxWidth,
        } : undefined}
      >
        <button
          type="button"
          className="floating-toolbar-drag-handle"
          aria-label={position ? '拖动工具条；双击或按 Home 归位' : '拖动工具条位置'}
          title={position ? '拖动调整位置；双击归位' : '拖动调整工具条位置'}
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={() => {
            dragStateRef.current = null;
            setDragging(false);
          }}
          onDoubleClick={resetPosition}
          onKeyDown={moveWithKeyboard}
        >
          <ToolbarDragIcon />
        </button>
        <div className="floating-toolbar-scroll">
          {visibleGroups.map((group, groupIndex) => (
            <div className="floating-toolbar-group" key={group.id}>
              {group.actions.map((action) => (
                <ToolbarButton action={action} key={action.id} onAction={resetPosition} />
              ))}
              {groupIndex < visibleGroups.length - 1 && <span className="floating-toolbar-separator" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolbarDragIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="7" r="1.35" fill="currentColor" />
      <circle cx="16" cy="7" r="1.35" fill="currentColor" />
      <circle cx="8" cy="12" r="1.35" fill="currentColor" />
      <circle cx="16" cy="12" r="1.35" fill="currentColor" />
      <circle cx="8" cy="17" r="1.35" fill="currentColor" />
      <circle cx="16" cy="17" r="1.35" fill="currentColor" />
    </svg>
  );
}

function ToolbarButton({ action, onAction }: { action: FloatingToolbarAction; onAction: () => void }) {
  const button = (
    <button
      type="button"
      className={`floating-toolbar-button is-${action.variant || 'secondary'}${action.className ? ` ${action.className}` : ''}`}
      onClick={() => {
        onAction();
        action.onClick();
      }}
      disabled={action.disabled}
    >
      {action.icon && <span className="floating-toolbar-icon" aria-hidden="true">{action.icon}</span>}
      <span>{action.label}</span>
    </button>
  );

  if (!action.tooltip) {
    return button;
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="top" align="center" sideOffset={10}>
          {action.tooltip}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ToolbarArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 18 9 12l6-6" />
    </svg>
  );
}

export function ToolbarArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ToolbarDocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3.75h6.7L18 8.05v12.2H7z" />
      <path d="M13.5 4v4.35h4.25" />
      <path d="M9.5 12.2h5" />
      <path d="M9.5 15.7h4" />
    </svg>
  );
}

export function ToolbarSparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 4.5 13.8 9.2 18.5 11 13.8 12.8 12 17.5 10.2 12.8 5.5 11 10.2 9.2z" />
      <path d="M18.6 4.4v3.2" />
      <path d="M17 6h3.2" />
      <path d="M6.2 16.6v2.8" />
      <path d="M4.8 18h2.8" />
    </svg>
  );
}

export function ToolbarOutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6.5 7h11" />
      <path d="M6.5 12h11" />
      <path d="M6.5 17h7" />
      <path d="M3.75 7h.01" />
      <path d="M3.75 12h.01" />
      <path d="M3.75 17h.01" />
    </svg>
  );
}

export default FloatingToolbar;
