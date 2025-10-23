import { Plugin, PluginSettingTab, App, Setting, MarkdownView, Editor, ButtonComponent, SliderComponent } from 'obsidian';

interface SmoothCursorSettings {
  blinkSpeed: number;
  blinkDelay: number;
  idleFadeCycles: number;
  movementTime: number;
  cursorWidth: number;
  caretColor: string;
  useCustomCaretColor: boolean;
}

const DEFAULT_SETTINGS: SmoothCursorSettings = {
  blinkSpeed: 1.2,
  blinkDelay: 0,
  idleFadeCycles: 10,
  movementTime: 80,
  cursorWidth: 1,
  caretColor: '#ffffff',
  useCustomCaretColor: false
};

type Coordinates = { left: number; top: number };
type Position = { line: number; ch: number };
interface ExtendedEditor extends Editor {
  containerEl: HTMLElement;
}

export default class SmoothCursorPlugin extends Plugin {
  settings: SmoothCursorSettings;
  cursorElement: HTMLSpanElement;
  isInWindow = true;
  isFirstFrame = true;

  mouseDown = false;
  mouseUpThisFrame = false;

  prevCursorCoords: Coordinates = { left: 0, top: 0 };
  currCursorCoords: Coordinates = { left: 0, top: 0 };
  currCursorHeight: number;

  prevCursorPos: Position = { line: 0, ch: 0 };
  currCursorPos: Position = { line: 0, ch: 0 };

  prevIconCoords: Coordinates = { left: 0, top: 0 };
  currIconCoords: Coordinates = { left: 0, top: 0 };

  lastValidCoords: Coordinates = { left: 0, top: 0 };

  prevFrameTime: number = Date.now();
  blinkStartTime: number = Date.now();

  remainingMoveTime = 0;
  async onload() {
    await this.loadSettings();
    this.initialiseCursor();

    // Add mouse event listeners
    document.addEventListener('mousedown', () => { this.mouseDown = true; });
    document.addEventListener('mouseup', () => { this.mouseDown = false; this.mouseUpThisFrame = true; });

    // Initialize blinking and start animation loop
    requestAnimationFrame(() => { this.blinkStartTime = Date.now(); });
    this.animateCursor();
  }

  onunload() {
    if (this.cursorElement) {
      this.cursorElement.remove();
    }
  }
  initialiseCursor() {
    this.cursorElement = document.body.createSpan({ cls: "custom-cursor" });
    this.addStyle();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new SmoothCursorSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.addStyle(); // Update styles when settings change
  }
  private addStyle() {
    const styleId = 'custom-cursor-style';
    // Remove existing style to allow updates
    const existingStyle = document.getElementById(styleId);
    if (existingStyle) {
      existingStyle.remove();
    }

    const style = document.createElement('style');
    style.id = styleId;

    if (this.settings.useCustomCaretColor) {
      // Use the custom color directly with high specificity
      style.textContent = `
				.custom-cursor {
					/* Assign variables */
					--cursor-width: 1px;

					/* Use custom color */
					background: ${this.settings.caretColor} !important;
					opacity: var(--cursor-opacity);

					height: var(--cursor-height);
					max-height: calc(var(--font-ui-large) * 2);
					width: var(--cursor-width);
					position: absolute;
					top: 0px;
					left: 0px;

					transform: translate(var(--cursor-x1), var(--cursor-y1));
					pointer-events: none;
				}

				.cm-editor * {
					caret-color: transparent;
				}
			`;
    } else {
      // Use CSS variable approach that respects user CSS snippets and themes
      style.textContent = `
				/* Base cursor styles */
				.custom-cursor {
					/* Assign variables */
					--cursor-width: 1px;

					/* Basic properties */
					opacity: var(--cursor-opacity);
					height: var(--cursor-height);
					max-height: calc(var(--font-ui-large) * 2);
					width: var(--cursor-width);
					position: absolute;
					top: 0px;
					left: 0px;
					transform: translate(var(--cursor-x1), var(--cursor-y1));
					pointer-events: none;

					/* Default background - lowest priority */
					background: var(--text-normal);
				}

				/* Medium priority - use caret color if available */
				.custom-cursor {
					background: var(--caret-color, var(--text-normal));
				}

				/* Higher priority selectors for theme-specific overrides */
				.theme-dark .custom-cursor,
				.theme-light .custom-cursor {
					background: var(--caret-color, var(--text-normal));
				}

				/* Highest priority - ensure CSS snippet overrides work */
				body.theme-dark .custom-cursor,
				body.theme-light .custom-cursor,
				html.theme-dark .custom-cursor,
				html.theme-light .custom-cursor {
					background: var(--caret-color, var(--text-normal));
				}

				/* Handle any context where CSS variables might be defined */
				/* This creates a fallback chain that works in any scope */
				* .custom-cursor {
					background: var(--caret-color, var(--text-normal));
				}

				/* Force re-evaluation of CSS variables in all possible contexts */
				[class] .custom-cursor {
					background: var(--caret-color, var(--text-normal));
				}

				.cm-editor * {
					caret-color: transparent;
				}
			`;
    }

    document.head.appendChild(style);
  }

  /**
   * Parent function which runs every frame. Divorced from main architecture so that errors don't stop the cursor from rendering forever.
   * Everything should be wrapped safely within a try/catch statements so that this function will always be called every frame
   */
  private animateCursor() {
    const returnStatement = () => {
      this.mouseUpThisFrame = false;
      requestAnimationFrame(this.animateCursor.bind(this));
    };

    try {
      const timeSinceLastFrame = this.getTimeSinceLastFrame();
      const { selection, editor } = this.returnReferences();

      if (!this.checkLegalCursor(selection, editor) || !selection || !editor) {
        return returnStatement();
      }

      this.updateCursorInfo(selection, editor);
      this.setCursorBlinkOpacity();
      this.updateCursorPosition(timeSinceLastFrame, selection, editor);
    }
    catch (error) {
      console.error(error);
    }

    return returnStatement();
  }
  /**
   * Main function to check if the cursor is in a legal state and should be visible.
   * A legal state is defined as a currently active selection and editor which is focused.
   * Now includes support for text selection while maintaining smooth cursor functionality.
   */
  private checkLegalCursor(selection: Selection | null, editor: ExtendedEditor | null): boolean {
    const setIconState = (state: string) => {
      if (this.cursorElement.style.display === state) { return; }
      this.cursorElement.style.display = state;
    }

    const legalCursor = () => { setIconState('block'); return true; }
    const illegalCursor = () => { setIconState('none'); return false; }

    if (
      !selection || !selection.focusNode ||
      !editor || !editor.containerEl ||
      !editor.containerEl.className.includes('cm-focused') ||
      !editor.getCursor()
    ) {
      return illegalCursor();
    }

    return legalCursor();
  }

  private updateCursorPosition(timeSinceLastFrame: number, selection: Selection, editor: ExtendedEditor) {
    if (this.isFirstFrame) {
      this.currIconCoords = this.currCursorCoords;
      this.isFirstFrame = false;
    }
    else {
      this.moveSmoothly(this.checkSmoothMovement(this.currCursorCoords), timeSinceLastFrame);
    }

    // Send cursor details to CSS to render
    this.cursorElement.style.setProperty("--cursor-x1", `${this.currIconCoords.left}px`);
    this.cursorElement.style.setProperty("--cursor-y1", `${this.currIconCoords.top}px`);
    this.cursorElement.style.setProperty("--cursor-height", `${this.currCursorHeight}px`);
    this.cursorElement.style.setProperty("--cursor-width", `${this.settings.cursorWidth}px`);

    // Update values on every frame
    this.prevCursorCoords = this.currCursorCoords; this.prevIconCoords = this.currIconCoords;
    this.prevCursorPos = this.currCursorPos;
  }
  // Handles fading of cursor and resets if it moves
  private setCursorBlinkOpacity() {
    const returnStatement = (blinkOpacity: number) => {
      this.cursorElement.style.setProperty("--cursor-opacity", `${blinkOpacity}`);
    }

    // Check if cursor position has changed
    const cursorCoordsChanged = (
      this.prevCursorCoords.left !== this.currCursorCoords.left ||
      this.prevCursorCoords.top !== this.currCursorCoords.top
    );
    if (cursorCoordsChanged) {
      requestAnimationFrame(() => { this.blinkStartTime = Date.now(); });
      return returnStatement(1);
    }

    // Use smooth fade in/out with sine wave that goes from 0 to 1
    const timePassed = Date.now() - this.blinkStartTime - this.settings.blinkDelay * 1000;
    const blinkMs = this.settings.blinkSpeed * 1000;
    const isPastFadeCycles = this.settings.idleFadeCycles != 0 && timePassed > blinkMs * this.settings.idleFadeCycles;

    if (timePassed < 0 || isPastFadeCycles) { return returnStatement(1); }

    // Create smooth sine wave fade (0 to 1.0 range for full transparency)
    const cycle = (timePassed % blinkMs) / blinkMs; // 0 to 1
    const opacity = Math.sin(cycle * Math.PI * 2) * 0.5 + 0.5;
    return returnStatement(opacity);
  }
  // Smooth typing function that returns whether anything has started or violated a smooth movement on this frame.
  private checkSmoothMovement(currCursorCoords: Coordinates): boolean {
    // If the iconCoords and cursorCoords are the same, then we do not need a smoothMovement
    if (
      this.prevIconCoords &&
      this.prevIconCoords.left === currCursorCoords.left &&
      this.prevIconCoords.top === currCursorCoords.top
    ) {
      return false;
    }

    // Check if the cursorPosition has changed this frame - if it has, we reset the remainingMoveTime
    if (
      this.prevCursorPos.line !== this.currCursorPos.line ||
      this.prevCursorPos.ch !== this.currCursorPos.ch
    ) {
      this.remainingMoveTime = this.settings.movementTime;
    }
    return true;
  }

  // Handle the interpolation of the cursor icon for the smoothMovement
  private moveSmoothly(isMovingSmoothly: boolean, timeSinceLastFrame: number): void {
    // If no smooth movement or movement has finished, iconCoords should match true cursorCoords
    if (!isMovingSmoothly || this.remainingMoveTime <= 0) {
      this.remainingMoveTime = 0;
      this.currIconCoords = this.currCursorCoords;
      return;
    }

    // Otherwise calculate the fraction of the remaining time that has passed since the last frame
    const fractionTravelled = Math.min(timeSinceLastFrame / this.remainingMoveTime, 1);
    this.remainingMoveTime = Math.max(0, this.remainingMoveTime - timeSinceLastFrame);

    const movementThisFrame: Coordinates = {
      left: fractionTravelled * (this.currCursorCoords.left - this.prevIconCoords.left),
      top: fractionTravelled * (this.currCursorCoords.top - this.prevIconCoords.top)
    };
    this.currIconCoords = {
      left: this.prevIconCoords.left + movementThisFrame.left,
      top: this.prevIconCoords.top + movementThisFrame.top
    };
  }

  private returnReferences(): { selection: Selection | null; editor: ExtendedEditor | null } {
    const selection = window.getSelection();
    const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor: ExtendedEditor | null = activeLeaf ? (activeLeaf.editor as ExtendedEditor) : null;
    return { selection, editor };
  }

  private getTimeSinceLastFrame(): number {
    const currentTime = Date.now();
    const timeSinceLastFrame = currentTime - this.prevFrameTime;
    this.prevFrameTime = currentTime;
    return timeSinceLastFrame;
  } private updateCursorInfo(selection: Selection, editor: ExtendedEditor): void {
    // Update current cursor pos in terms of character and line
    this.currCursorPos = editor.getCursor();

    // Confirm that selection has focused node
    if (!selection.focusNode) { return; }

    // Handle text selection: use the focus/anchor position for cursor placement
    let cursorRange = document.createRange();

    try {
      // For text selections, use the focus position (where cursor would be)
      if (selection.rangeCount > 0 && !selection.isCollapsed) {
        // There's a text selection - position cursor at the focus end
        cursorRange.setStart(selection.focusNode, selection.focusOffset);
        cursorRange.setEnd(selection.focusNode, selection.focusOffset);
      } else {
        // Normal cursor positioning
        cursorRange.setStart(selection.focusNode, selection.focusOffset);
        if (selection.focusOffset === 0) {
          cursorRange.setEnd(selection.focusNode, 1);
        } else {
          cursorRange.setEnd(selection.focusNode, selection.focusOffset);
        }
      }

      const cursorInfo = cursorRange.getBoundingClientRect();

      // Only update coordinates if they are valid (not at origin)
      if (cursorInfo.left > 0 || cursorInfo.top > 0 || (cursorInfo.left === 0 && cursorInfo.top === 0 && this.lastValidCoords.left === 0 && this.lastValidCoords.top === 0)) {
        this.currCursorCoords = { left: cursorInfo.left, top: cursorInfo.top };
        this.currCursorHeight = cursorInfo.height;

        // Store last valid coordinates to prevent jumping from top-left
        if (cursorInfo.left > 0 || cursorInfo.top > 0) {
          this.lastValidCoords = { left: cursorInfo.left, top: cursorInfo.top };
        }
      } else {
        // Use last valid coordinates to prevent jumping from top-left
        this.currCursorCoords = this.lastValidCoords;
      }
    } catch (error) {
      // If there's an error getting cursor info, use last valid coordinates
      this.currCursorCoords = this.lastValidCoords;
    }
  }
}

// SUPPORTING CLASSES
class ResetButtonComponent extends ButtonComponent {
  constructor(protected contentEl: HTMLElement) {
    super(contentEl);
    this.setTooltip('Restore default');
    this.setIcon('rotate-ccw');
    this.render();
  }

  private render(): void {
    this.buttonEl.classList.add('clickable-icon');
    this.buttonEl.classList.add('extra-setting-button');
  }
}

class SmoothCursorSettingTab extends PluginSettingTab {
  plugin: SmoothCursorPlugin;

  constructor(app: App, plugin: SmoothCursorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Smooth Cursor Settings' });

    // BLINK SPEED SLIDER
    const blinkSpeedSetting = new Setting(this.containerEl)
      .setName('Fade speed (in seconds)')
      .setDesc('The number of seconds to complete one full cursor fade cycle.')
    new ResetButtonComponent(blinkSpeedSetting.controlEl)
      .onClick(async () => {
        blinkSpeedSlider.setValue(DEFAULT_SETTINGS.blinkSpeed);
        await this.plugin.saveSettings();
      });
    const blinkSpeedSlider = new SliderComponent(blinkSpeedSetting.controlEl)
      .setLimits(0.2, 5, 0.1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.blinkSpeed ?? DEFAULT_SETTINGS.blinkSpeed)
      .onChange(async (val) => {
        this.plugin.settings.blinkSpeed = val;
        await this.plugin.saveSettings();
      });    // FADE DELAY SLIDER
    const blinkDelaySetting = new Setting(this.containerEl)
      .setName('Fade delay (in seconds)')
      .setDesc('The number of seconds after cursor movement before fading begins.')
    new ResetButtonComponent(blinkDelaySetting.controlEl)
      .onClick(async () => {
        blinkDelaySlider.setValue(DEFAULT_SETTINGS.blinkDelay);
        await this.plugin.saveSettings();
      });
    const blinkDelaySlider = new SliderComponent(blinkDelaySetting.controlEl)
      .setLimits(0, 5, 0.1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.blinkDelay ?? DEFAULT_SETTINGS.blinkDelay)
      .onChange(async (val) => {
        this.plugin.settings.blinkDelay = val;
        await this.plugin.saveSettings();
      });
      // IDLE FADE CYCLES SLIDER
    const idleFadeCyclesSetting = new Setting(this.containerEl)
      .setName('Idle fade cycles')
      .setDesc('When the cursor is idle, the number of fade cycles before it stops blinking. 0 to disable.')
    new ResetButtonComponent(idleFadeCyclesSetting.controlEl)
      .onClick(async () => {
        idleFadeCyclesSlider.setValue(DEFAULT_SETTINGS.idleFadeCycles);
        await this.plugin.saveSettings();
      });
    const idleFadeCyclesSlider = new SliderComponent(idleFadeCyclesSetting.controlEl)
      .setLimits(0, 50, 1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.idleFadeCycles ?? DEFAULT_SETTINGS.idleFadeCycles)
      .onChange(async (val) => {
        this.plugin.settings.idleFadeCycles = val;
        await this.plugin.saveSettings();
      });

    // SMOOTH TYPING SPEED SLIDER
    const smoothTypingSetting = new Setting(this.containerEl)
      .setName('Smooth typing speed (in milliseconds)')
      .setDesc('The number of milliseconds for the cursor icon to reach the true cursor location after typing or moving the cursor. 0 for instant speed.')
    new ResetButtonComponent(smoothTypingSetting.controlEl)
      .onClick(async () => {
        smoothTypingSpeedSlider.setValue(DEFAULT_SETTINGS.movementTime);
        await this.plugin.saveSettings();
      });
    const smoothTypingSpeedSlider = new SliderComponent(smoothTypingSetting.controlEl)
      .setLimits(0, 200, 1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.movementTime ?? DEFAULT_SETTINGS.movementTime)
      .onChange(async (val) => {
        this.plugin.settings.movementTime = val;
        await this.plugin.saveSettings();
      });

    // CURSOR WIDTH SLIDER
    const cursorWidthSetting = new Setting(this.containerEl)
      .setName('Cursor width (in pixels)')
      .setDesc('The width of the cursor icon in pixels.')
    new ResetButtonComponent(cursorWidthSetting.controlEl)
      .onClick(async () => {
        cursorWidthSlider.setValue(DEFAULT_SETTINGS.cursorWidth);
        await this.plugin.saveSettings();
      });
    const cursorWidthSlider = new SliderComponent(cursorWidthSetting.controlEl)
      .setLimits(1, 5, 1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.cursorWidth ?? DEFAULT_SETTINGS.cursorWidth)
      .onChange(async (val) => {
        this.plugin.settings.cursorWidth = val;
        await this.plugin.saveSettings();
      });

    // CUSTOM CARET COLOR TOGGLE
    new Setting(this.containerEl)
      .setName('Use custom caret color')
      .setDesc('Enable custom caret color instead of using theme/CSS variable. When disabled, the cursor will use --caret-color CSS variable or fall back to --text-normal.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.useCustomCaretColor ?? DEFAULT_SETTINGS.useCustomCaretColor)
        .onChange(async (value) => {
          this.plugin.settings.useCustomCaretColor = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh the settings display
        }));

    // CUSTOM CARET COLOR PICKER (only show if custom color is enabled)
    if (this.plugin.settings.useCustomCaretColor) {
      const caretColorSetting = new Setting(this.containerEl)
        .setName('Caret color')
        .setDesc('Choose a custom color for the cursor caret.')

      new ResetButtonComponent(caretColorSetting.controlEl)
        .onClick(async () => {
          this.plugin.settings.caretColor = DEFAULT_SETTINGS.caretColor;
          await this.plugin.saveSettings();
          this.display(); // Refresh to show updated color
        });

      // Create color input
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = this.plugin.settings.caretColor ?? DEFAULT_SETTINGS.caretColor;
      colorInput.style.width = '50px';
      colorInput.style.height = '30px';
      colorInput.style.border = 'none';
      colorInput.style.borderRadius = '4px';
      colorInput.style.cursor = 'pointer';

      colorInput.addEventListener('change', async (event) => {
        const target = event.target as HTMLInputElement;
        this.plugin.settings.caretColor = target.value;
        await this.plugin.saveSettings();
      });

      caretColorSetting.controlEl.appendChild(colorInput);
    }
  }
}
