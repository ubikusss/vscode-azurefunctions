/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as extract from 'extract-zip';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext, parseError } from 'vscode-azureextensionui';
import { betaReleaseVersion, ProjectLanguage, ProjectRuntime, TemplateFilter, templateVersionSetting, v1ReleaseVersion } from '../constants';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { getFuncExtensionSetting, updateGlobalSetting } from '../ProjectSettings';
import { dotnetUtils } from '../utils/dotnetUtils';
import { downloadFile } from '../utils/fs';
import { cliFeedJsonResponse, getFeedRuntime, tryGetCliFeedJson } from '../utils/getCliFeedJson';
import { executeDotnetTemplateCommand, getDotnetItemTemplatePath, getDotnetProjectTemplatePath } from './executeDotnetTemplateCommand';
import { IFunctionTemplate, TemplateCategory } from './IFunctionTemplate';
import { parseDotnetTemplates } from './parseDotnetTemplates';
import { parseScriptTemplates } from './parseScriptTemplates';

const templatesKey: string = 'FunctionTemplates';
const configKey: string = 'FunctionTemplateConfig';
const resourcesKey: string = 'FunctionTemplateResources';
const dotnetTemplatesKey: string = 'DotnetTemplates';
const templateVersionKey: string = 'templateVersion';
const tempPath: string = path.join(os.tmpdir(), 'vscode-azurefunctions-templates');

const verifiedV1Templates: string[] = [
    'BlobTrigger-JavaScript',
    'GenericWebHook-JavaScript',
    'GitHubWebHook-JavaScript',
    'HttpTrigger-JavaScript',
    'HttpTriggerWithParameters-JavaScript',
    'ManualTrigger-JavaScript',
    'QueueTrigger-JavaScript',
    'TimerTrigger-JavaScript',
    'Azure.Function.CSharp.HttpTrigger.1.x',
    'Azure.Function.CSharp.BlobTrigger.1.x',
    'Azure.Function.CSharp.QueueTrigger.1.x',
    'Azure.Function.CSharp.TimerTrigger.1.x'
];

const verifiedV2Templates: string[] = [
    'BlobTrigger-JavaScript',
    'HttpTrigger-JavaScript',
    'QueueTrigger-JavaScript',
    'TimerTrigger-JavaScript',
    'Azure.Function.CSharp.HttpTrigger.2.x',
    'Azure.Function.CSharp.BlobTrigger.2.x',
    'Azure.Function.CSharp.QueueTrigger.2.x',
    'Azure.Function.CSharp.TimerTrigger.2.x'
];

const verifiedJavaTemplates: string[] = [
    'HttpTrigger',
    'BlobTrigger',
    'QueueTrigger',
    'TimerTrigger'
];
/**
 * Main container for all template data retrieved from the Azure Functions Portal. See README.md for more info and example of the schema.
 * We cache the template data retrieved from the portal so that the user can create functions offline.
 */
export class TemplateData {
    private readonly _templatesMap: { [runtime: string]: IFunctionTemplate[] | undefined } = {};
    // if there are no templates, then there is likely no internet or a problem with the clifeed url
    private readonly _noInternetErrMsg: string = localize('retryInternet', 'There was an error in retrieving the templates.  Recheck your internet connection and try again.');
    constructor(templatesMap: { [runtime: string]: IFunctionTemplate[] | undefined }) {
        this._templatesMap = templatesMap;
    }

    public async getTemplates(language: string, runtime: string = ProjectRuntime.one, templateFilter?: string): Promise<IFunctionTemplate[]> {
        const templates: IFunctionTemplate[] | undefined = this._templatesMap[runtime];
        if (!templates) {
            throw new Error(this._noInternetErrMsg);
        }

        if (language === ProjectLanguage.Java) {
            // Currently we leverage JS templates to get the function metadata of Java Functions.
            // Will refactor the code here when templates HTTP API is ready.
            // See issue here: https://github.com/Microsoft/vscode-azurefunctions/issues/84
            const javaTemplates: IFunctionTemplate[] = templates.filter((t: IFunctionTemplate) => t.language === ProjectLanguage.JavaScript);
            return javaTemplates.filter((t: IFunctionTemplate) => verifiedJavaTemplates.find((vt: string) => vt === removeLanguageFromId(t.id)));
        } else {
            let filterTemplates: IFunctionTemplate[] = templates.filter((t: IFunctionTemplate) => t.language.toLowerCase() === language.toLowerCase());
            switch (templateFilter) {
                case TemplateFilter.All:
                    break;
                case TemplateFilter.Core:
                    filterTemplates = filterTemplates.filter((t: IFunctionTemplate) => t.categories.find((c: TemplateCategory) => c === TemplateCategory.Core) !== undefined);
                    break;
                case TemplateFilter.Verified:
                default:
                    const verifiedTemplates: string[] = runtime === ProjectRuntime.one ? verifiedV1Templates : verifiedV2Templates;
                    filterTemplates = filterTemplates.filter((t: IFunctionTemplate) => verifiedTemplates.find((vt: string) => vt === t.id));
            }

            return filterTemplates;
        }
    }
}

async function verifyTemplatesByRuntime(templates: IFunctionTemplate[], runtime: ProjectRuntime): Promise<void> {
    let verifiedTemplates: string[] = runtime === ProjectRuntime.one ? verifiedV1Templates : verifiedV2Templates;
    try {
        await dotnetUtils.validateDotnetInstalled();
    } catch {
        // Don't verify dotnet templates if the .NET CLI isn't even installed
        verifiedTemplates = verifiedTemplates.filter((id: string) => !id.includes('CSharp'));
    }

    for (const verifiedTemplateId of verifiedTemplates) {
        if (!templates.some((t: IFunctionTemplate) => t.id === verifiedTemplateId)) {
            throw new Error(localize('failedToVerifiedTemplate', 'Failed to find verified template with id "{0}".', verifiedTemplateId));
        }
    }
}

export async function getTemplateData(globalState?: vscode.Memento): Promise<TemplateData> {
    const templatesMap: { [runtime: string]: IFunctionTemplate[] | undefined } = {};
    const cliFeedJson: cliFeedJsonResponse | undefined = await tryGetCliFeedJson();
    for (const key of Object.keys(ProjectRuntime)) {
        await callWithTelemetryAndErrorHandling('azureFunctions.getTemplateData', async function (this: IActionContext): Promise<void> {
            this.suppressErrorDisplay = true;
            this.properties.isActivationEvent = 'true';
            const runtime: ProjectRuntime = <ProjectRuntime>ProjectRuntime[key];
            this.properties.runtime = runtime;
            const templateVersion: string | undefined = await tryGetTemplateVersionSetting(this, cliFeedJson, runtime);
            let parsedTemplatesByRuntime: IFunctionTemplate[] | undefined;

            // 1. Use the cached templates if they match templateVersion
            if (globalState && globalState.get(`${templateVersionKey}-${runtime}`) === templateVersion) {
                parsedTemplatesByRuntime = await tryGetParsedTemplateDataFromCache(this, runtime, globalState);
                this.properties.templateSource = 'matchingCache';
            }

            // 2. Download templates from the cli-feed if the cache doesn't match templateVersion
            if (!parsedTemplatesByRuntime && cliFeedJson && templateVersion) {
                parsedTemplatesByRuntime = await tryGetParsedTemplateDataFromCliFeed(this, cliFeedJson, templateVersion, runtime, globalState);
                this.properties.templateSource = 'cliFeed';
            }

            // 3. Use the cached templates, even if they don't match templateVersion
            if (!parsedTemplatesByRuntime && globalState) {
                parsedTemplatesByRuntime = await tryGetParsedTemplateDataFromCache(this, runtime, globalState);
                this.properties.templateSource = 'mismatchCache';
            }

            // 4. Download templates from the cli-feed using the backupVersion
            if (!parsedTemplatesByRuntime && cliFeedJson) {
                const backupVersion: string = runtime === ProjectRuntime.one ? v1ReleaseVersion : betaReleaseVersion;
                parsedTemplatesByRuntime = await tryGetParsedTemplateDataFromCliFeed(this, cliFeedJson, backupVersion, runtime, globalState);
                this.properties.templateSource = 'backupCliFeed';
            }

            if (parsedTemplatesByRuntime) {
                templatesMap[runtime] = parsedTemplatesByRuntime;
            } else {
                // Failed to get templates for this runtime
                this.properties.templateSource = 'None';
            }
        });
    }
    return new TemplateData(templatesMap);
}

async function tryGetParsedTemplateDataFromCache(context: IActionContext, runtime: ProjectRuntime, globalState: vscode.Memento): Promise<IFunctionTemplate[] | undefined> {
    let templates: IFunctionTemplate[] = [];
    try {
        const cachedResources: object | undefined = globalState.get<object>(getRuntimeKey(resourcesKey, runtime));
        const cachedTemplates: object[] | undefined = globalState.get<object[]>(getRuntimeKey(templatesKey, runtime));
        const cachedConfig: object | undefined = globalState.get<object>(getRuntimeKey(configKey, runtime));
        if (cachedResources && cachedTemplates && cachedConfig) {
            templates = templates.concat(parseScriptTemplates(cachedResources, cachedTemplates, cachedConfig));
        }
        const cachedDotnetTemplates: object[] | undefined = globalState.get<object[]>(getRuntimeKey(dotnetTemplatesKey, runtime));
        if (cachedDotnetTemplates) {
            templates = templates.concat(parseDotnetTemplates(cachedDotnetTemplates, runtime));
        }
    } catch (error) {
        context.properties.cacheError = parseError(error).message;
    }
    return undefined;
}

async function tryGetParsedTemplateDataFromCliFeed(context: IActionContext, cliFeedJson: cliFeedJsonResponse, templateVersion: string, runtime: ProjectRuntime, globalState?: vscode.Memento): Promise<IFunctionTemplate[] | undefined> {
    try {
        context.properties.templateVersion = templateVersion;
        ext.outputChannel.appendLine(localize('downloadTemplates', 'Downloading "v{0}" templates. . .', templateVersion));
        await downloadAndExtractTemplates(cliFeedJson.releases[templateVersion].templateApiZip, templateVersion);
        const rawCSharpTemplates: object[] = await downloadAndExtractCSharpTemplates(cliFeedJson, templateVersion, runtime);
        ext.outputChannel.appendLine(localize('templatesExtracted', 'Finished downloading templates.'));

        // only Resources.json has a capital letter
        const rawResources: object = <object>await fse.readJSON(path.join(tempPath, 'resources', 'Resources.json'));
        const rawTemplates: object[] = <object[]>await fse.readJSON(path.join(tempPath, 'templates', 'templates.json'));
        const rawConfig: object = <object>await fse.readJSON(path.join(tempPath, 'bindings', 'bindings.json'));

        let templates: IFunctionTemplate[] = parseScriptTemplates(rawResources, rawTemplates, rawConfig);
        templates = templates.concat(parseDotnetTemplates(rawCSharpTemplates, runtime));
        await verifyTemplatesByRuntime(templates, runtime);
        if (globalState) {
            globalState.update(`${templateVersionKey}-${runtime}`, templateVersion);
            globalState.update(getRuntimeKey(templatesKey, runtime), rawTemplates);
            globalState.update(getRuntimeKey(configKey, runtime), rawConfig);
            globalState.update(getRuntimeKey(resourcesKey, runtime), rawResources);
            globalState.update(getRuntimeKey(dotnetTemplatesKey, runtime), rawCSharpTemplates);
        }
        return templates;

    } catch (error) {
        context.properties.cliFeedError = parseError(error).message;
        return undefined;
    } finally {
        if (await fse.pathExists(tempPath)) {
            await fse.remove(tempPath);
        }
    }
}

function getRuntimeKey(baseKey: string, runtime: ProjectRuntime): string {
    return runtime === ProjectRuntime.one ? baseKey : `${baseKey}.${runtime}`;
}

export function removeLanguageFromId(id: string): string {
    return id.split('-')[0];
}

async function downloadAndExtractTemplates(templateUrl: string, release: string): Promise<{}> {
    const filePath: string = path.join(tempPath, `templates-${release}.zip`);
    await downloadFile(templateUrl, filePath);

    return new Promise(async (resolve: () => void, reject: (e: Error) => void): Promise<void> => {
        // tslint:disable-next-line:no-unsafe-any
        extract(filePath, { dir: tempPath }, (err: Error) => {
            // tslint:disable-next-line:strict-boolean-expressions
            if (err) {
                reject(err);
            }
            resolve();
        });
    });
}

async function downloadAndExtractCSharpTemplates(cliFeedJson: cliFeedJsonResponse, templateVersion: string, runtime: ProjectRuntime): Promise<object[]> {
    try {
        await dotnetUtils.validateDotnetInstalled();
    } catch {
        ext.outputChannel.appendLine(localize('skippingDotnet', 'Skipping download of C# templates because the .NET CLI is not installed.'));
        return [];
    }

    const projectFilePath: string = getDotnetProjectTemplatePath(runtime);
    await downloadFile(cliFeedJson.releases[templateVersion].projectTemplates, projectFilePath);

    const itemFilePath: string = getDotnetItemTemplatePath(runtime);
    await downloadFile(cliFeedJson.releases[templateVersion].itemTemplates, itemFilePath);

    return <object[]>JSON.parse(await executeDotnetTemplateCommand(runtime, undefined, 'list'));
}

export async function tryGetTemplateVersionSetting(context: IActionContext, cliFeedJson: cliFeedJsonResponse | undefined, runtime: ProjectRuntime): Promise<string | undefined> {
    const feedRuntime: string = getFeedRuntime(runtime);
    const userTemplateVersion: string | undefined = getFuncExtensionSetting(templateVersionSetting);
    try {
        if (userTemplateVersion) {
            context.properties.userTemplateVersion = userTemplateVersion;
        }
        let templateVersion: string;
        if (cliFeedJson) {
            templateVersion = userTemplateVersion ? userTemplateVersion : cliFeedJson.tags[feedRuntime].release;
            // tslint:disable-next-line:strict-boolean-expressions
            if (!cliFeedJson.releases[templateVersion]) {
                const invalidVersion: string = localize('invalidTemplateVersion', 'Failed to retrieve Azure Functions templates for version "{0}".', templateVersion);
                const selectVersion: vscode.MessageItem = { title: localize('selectVersion', 'Select version') };
                const useLatest: vscode.MessageItem = { title: localize('useLatest', 'Use latest') };
                const warningInput: vscode.MessageItem = await ext.ui.showWarningMessage(invalidVersion, selectVersion, useLatest);
                if (warningInput === selectVersion) {
                    const releaseQuickPicks: vscode.QuickPickItem[] = [];
                    for (const rel of Object.keys(cliFeedJson.releases)) {
                        releaseQuickPicks.push({
                            label: rel,
                            description: ''
                        });
                    }
                    const input: vscode.QuickPickItem | undefined = await ext.ui.showQuickPick(releaseQuickPicks, { placeHolder: invalidVersion });
                    templateVersion = input.label;
                    await updateGlobalSetting(templateVersionSetting, input.label);
                } else {
                    templateVersion = cliFeedJson.tags[feedRuntime].release;
                    // reset user setting so that it always gets latest
                    await updateGlobalSetting(templateVersionSetting, '');

                }
            }
        } else {
            return undefined;
        }

        return templateVersion;
    } catch (error) {
        // if cliJson does not have the template version being searched for, it will throw an error
        context.properties.userTemplateVersion = parseError(error).message;
        return undefined;
    }

}
