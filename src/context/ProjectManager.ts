import * as vscode from 'vscode';
import {
  ProjectMetadata,
  ProjectRegistry,
  WorkflowPhase,
  WorkflowState,
  PhaseProgress,
  GeneratedArtifact,
  DataPlatformProvider,
  TargetEnvironment
} from '../core/types';

/**
 * Manages the .auto-de/ project system.
 * Each user requirement becomes a project with its own workflow state,
 * phase-level outcomes, and persisted artifacts.
 */
export class ProjectManager implements vscode.Disposable {
  private registry: ProjectRegistry = { activeProjectId: null, projects: [] };
  private autoDeUri: vscode.Uri;
  private registryUri: vscode.Uri;
  private fileWatcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.autoDeUri = vscode.Uri.joinPath(workspaceUri, '.auto-de');
    this.registryUri = vscode.Uri.joinPath(this.autoDeUri, 'projects.json');
  }

  dispose(): void {
    this.fileWatcher?.dispose();
  }

  // ── Initialization ──

  async initialize(): Promise<void> {
    // Ensure .auto-de directory exists
    try {
      await vscode.workspace.fs.createDirectory(this.autoDeUri);
    } catch {
      // Directory may already exist
    }

    // Load registry
    try {
      const content = await vscode.workspace.fs.readFile(this.registryUri);
      this.registry = JSON.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded project registry: ${this.registry.projects.length} project(s)`);
    } catch {
      this.registry = { activeProjectId: null, projects: [] };
      await this.saveRegistry();
      this.log('Initialized empty project registry.');
    }

    // Watch for external changes
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceUri, '.auto-de/projects.json')
    );
    this.fileWatcher.onDidChange(async () => {
      try {
        const content = await vscode.workspace.fs.readFile(this.registryUri);
        this.registry = JSON.parse(Buffer.from(content).toString('utf8'));
        this.log('Project registry reloaded from disk.');
      } catch {
        // Ignore
      }
    });
  }

  // ── Project CRUD ──

  getProjects(): ProjectMetadata[] {
    return [...this.registry.projects];
  }

  getActiveProject(): ProjectMetadata | undefined {
    if (!this.registry.activeProjectId) return undefined;
    return this.registry.projects.find((p) => p.id === this.registry.activeProjectId);
  }

  getProject(id: string): ProjectMetadata | undefined {
    return this.registry.projects.find((p) => p.id === id);
  }

  setActiveProject(id: string): void {
    if (!this.registry.projects.some((p) => p.id === id)) {
      throw new Error(`Project "${id}" not found.`);
    }
    this.registry.activeProjectId = id;
    this.saveRegistry();
    this.log(`Active project set to: ${id}`);
  }

  createProject(
    objective: string,
    sourceProvider: DataPlatformProvider,
    targetEnvironment?: TargetEnvironment
  ): ProjectMetadata {
    const id = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = this.generateProjectName(objective);
    const now = new Date().toISOString();

    const project: ProjectMetadata = {
      id,
      name,
      objective,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      currentPhase: 'discover',
      sourceProvider,
      targetEnvironment,
      phaseProgress: {
        discover: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0 },
        model: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0 },
        build: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0 },
        validate: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0 }
      }
    };

    this.registry.projects.push(project);
    this.registry.activeProjectId = id;
    this.saveRegistry();

    // Create project directory structure
    this.createProjectDirectories(id);

    // Initialize workflow state
    this.saveWorkflowState(id, this.createInitialWorkflowState(id));

    this.log(`Project created: ${name} (${id})`);
    return project;
  }

  updateProject(id: string, updates: Partial<ProjectMetadata>): void {
    const idx = this.registry.projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Project "${id}" not found.`);

    this.registry.projects[idx] = {
      ...this.registry.projects[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.saveRegistry();
  }

  deleteProject(id: string): void {
    this.registry.projects = this.registry.projects.filter((p) => p.id !== id);
    if (this.registry.activeProjectId === id) {
      this.registry.activeProjectId = this.registry.projects[0]?.id ?? null;
    }
    this.saveRegistry();
    this.log(`Project "${id}" deleted.`);
  }

  // ── Phase Management ──

  setCurrentPhase(projectId: string, phase: WorkflowPhase): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);

    project.currentPhase = phase;
    project.updatedAt = new Date().toISOString();

    // Mark phase as in-progress if not started
    if (project.phaseProgress[phase].status === 'not-started') {
      project.phaseProgress[phase].status = 'in-progress';
      project.phaseProgress[phase].startedAt = new Date().toISOString();
    }

    this.saveRegistry();
    this.saveWorkflowState(projectId, this.buildWorkflowState(project));
  }

  updatePhaseProgress(
    projectId: string,
    phase: WorkflowPhase,
    progress: Partial<PhaseProgress>
  ): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);

    project.phaseProgress[phase] = {
      ...project.phaseProgress[phase],
      ...progress
    };
    project.updatedAt = new Date().toISOString();

    // Auto-advance phase if completed
    if (progress.status === 'completed') {
      project.phaseProgress[phase].completedAt = new Date().toISOString();
      const nextPhase = this.getNextPhase(phase);
      if (nextPhase) {
        project.currentPhase = nextPhase;
      }
    }

    this.saveRegistry();
    this.saveWorkflowState(projectId, this.buildWorkflowState(project));
  }

  getNextPhase(current: WorkflowPhase): WorkflowPhase | null {
    const order: WorkflowPhase[] = ['discover', 'model', 'build', 'validate'];
    const idx = order.indexOf(current);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  }

  isPhaseLocked(projectId: string, phase: WorkflowPhase): boolean {
    const order: WorkflowPhase[] = ['discover', 'model', 'build', 'validate'];
    const idx = order.indexOf(phase);
    if (idx <= 0) return false; // Discover is never locked

    const project = this.getProject(projectId);
    if (!project) return true;

    // Check if all previous phases are completed
    for (let i = 0; i < idx; i++) {
      if (project.phaseProgress[order[i]].status !== 'completed') {
        return true;
      }
    }
    return false;
  }

  // ── Artifact Persistence ──

  async persistArtifact(
    projectId: string,
    phase: WorkflowPhase,
    artifact: GeneratedArtifact
  ): Promise<void> {
    const phaseDir = this.getPhasePath(projectId, phase);
    await vscode.workspace.fs.createDirectory(phaseDir);

    const ext = this.getFileExtension(artifact.language);
    const safeName = artifact.title.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fileName = `${safeName}.${ext}`;
    const fileUri = vscode.Uri.joinPath(phaseDir, fileName);

    // Atomic write
    const tempUri = vscode.Uri.joinPath(phaseDir, `.tmp-${Date.now()}-${fileName}`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(artifact.content, 'utf8'));
    await vscode.workspace.fs.rename(tempUri, fileUri, { overwrite: true });

    // Update artifact with file path
    artifact.filePath = vscode.workspace.asRelativePath(fileUri);
    artifact.phase = phase;

    // Update workflow state
    const project = this.getProject(projectId);
    if (project) {
      project.phaseProgress[phase].artifactCount++;
      this.saveRegistry();
      this.saveWorkflowState(projectId, this.buildWorkflowState(project));
    }

    this.log(`Artifact persisted: ${artifact.title} → ${artifact.filePath}`);
  }

  getArtifacts(projectId: string, phase: WorkflowPhase): GeneratedArtifact[] {
    // Return artifacts from the workflow state
    const state = this.loadWorkflowState(projectId);
    if (!state) return [];

    return (state.phases[phase]?.artifacts ?? []).map((a) => ({
      id: a.id,
      type: a.type as GeneratedArtifact['type'],
      title: a.title,
      description: '',
      content: '',
      language: 'markdown',
      generatedBy: 'sourceAssessmentAgent',
      generatedAt: '',
      approved: false,
      filePath: a.filePath,
      phase
    }));
  }

  // ── File System ──

  getProjectPath(projectId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.autoDeUri, 'projects', projectId);
  }

  getPhasePath(projectId: string, phase: WorkflowPhase): vscode.Uri {
    const phaseDirs: Record<WorkflowPhase, string> = {
      discover: '01-discover',
      model: '02-model',
      build: '03-build',
      validate: '04-validate'
    };
    return vscode.Uri.joinPath(this.getProjectPath(projectId), phaseDirs[phase]);
  }

  async openProjectFolder(projectId: string): Promise<void> {
    const uri = this.getProjectPath(projectId);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  async openPhaseFolder(projectId: string, phase: WorkflowPhase): Promise<void> {
    const uri = this.getPhasePath(projectId, phase);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  // ── Private Helpers ──

  private generateProjectName(objective: string): string {
    const words = objective
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    return words.length > 0
      ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : 'Untitled Project';
  }

  private getFileExtension(language: string): string {
    switch (language) {
      case 'sql': return 'sql';
      case 'yaml': return 'yaml';
      case 'markdown': return 'md';
      case 'python': return 'py';
      case 'json': return 'json';
      default: return 'txt';
    }
  }

  private async createProjectDirectories(projectId: string): Promise<void> {
    const phases: WorkflowPhase[] = ['discover', 'model', 'build', 'validate'];
    for (const phase of phases) {
      try {
        await vscode.workspace.fs.createDirectory(this.getPhasePath(projectId, phase));
      } catch {
        // Directory may already exist
      }
    }
  }

  private createInitialWorkflowState(projectId: string): WorkflowState {
    return {
      projectId,
      currentPhase: 'discover',
      phases: {
        discover: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0, artifacts: [] },
        model: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0, artifacts: [] },
        build: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0, artifacts: [] },
        validate: { status: 'not-started', completedSteps: 0, totalSteps: 0, artifactCount: 0, artifacts: [] }
      }
    };
  }

  private buildWorkflowState(project: ProjectMetadata): WorkflowState {
    return {
      projectId: project.id,
      currentPhase: project.currentPhase,
      phases: {
        discover: {
          status: project.phaseProgress.discover.status,
          completedSteps: project.phaseProgress.discover.completedSteps,
          totalSteps: project.phaseProgress.discover.totalSteps,
          artifactCount: project.phaseProgress.discover.artifactCount,
          artifacts: []
        },
        model: {
          status: project.phaseProgress.model.status,
          completedSteps: project.phaseProgress.model.completedSteps,
          totalSteps: project.phaseProgress.model.totalSteps,
          artifactCount: project.phaseProgress.model.artifactCount,
          artifacts: []
        },
        build: {
          status: project.phaseProgress.build.status,
          completedSteps: project.phaseProgress.build.completedSteps,
          totalSteps: project.phaseProgress.build.totalSteps,
          artifactCount: project.phaseProgress.build.artifactCount,
          artifacts: []
        },
        validate: {
          status: project.phaseProgress.validate.status,
          completedSteps: project.phaseProgress.validate.completedSteps,
          totalSteps: project.phaseProgress.validate.totalSteps,
          artifactCount: project.phaseProgress.validate.artifactCount,
          artifacts: []
        }
      }
    };
  }

  private saveWorkflowState(projectId: string, state: WorkflowState): void {
    const yaml = this.serializeWorkflowYaml(state);
    const projectDir = this.getProjectPath(projectId);
    const tempUri = vscode.Uri.joinPath(projectDir, `.project.tmp.${Date.now()}.yaml`);
    const targetUri = vscode.Uri.joinPath(projectDir, 'project.yaml');

    vscode.workspace.fs.writeFile(tempUri, Buffer.from(yaml, 'utf8')).then(() => {
      vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });
    });
  }

  private loadWorkflowState(projectId: string): WorkflowState | null {
    // In-memory only for now; full disk read can be added later
    const project = this.getProject(projectId);
    if (!project) return null;
    return this.buildWorkflowState(project);
  }

  private serializeWorkflowYaml(state: WorkflowState): string {
    const lines: string[] = [
      `# AutoDE Workflow State`,
      `projectId: ${state.projectId}`,
      `currentPhase: ${state.currentPhase}`,
      '',
      'phases:'
    ];

    for (const [phase, data] of Object.entries(state.phases)) {
      lines.push(`  ${phase}:`);
      lines.push(`    status: ${data.status}`);
      lines.push(`    completedSteps: ${data.completedSteps}`);
      lines.push(`    totalSteps: ${data.totalSteps}`);
      lines.push(`    artifactCount: ${data.artifactCount}`);
      if (data.artifacts.length > 0) {
        lines.push('    artifacts:');
        for (const a of data.artifacts) {
          lines.push(`      - id: ${a.id}`);
          lines.push(`        type: ${a.type}`);
          lines.push(`        title: ${a.title}`);
          lines.push(`        filePath: ${a.filePath}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  private async saveRegistry(): Promise<void> {
    const json = JSON.stringify(this.registry, null, 2);
    const tempUri = vscode.Uri.joinPath(this.autoDeUri, `.projects.tmp.${Date.now()}.json`);

    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(json, 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.registryUri, { overwrite: true });
  }
}