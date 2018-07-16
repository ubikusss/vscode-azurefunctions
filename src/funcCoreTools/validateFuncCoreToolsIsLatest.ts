/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// tslint:disable-next-line:no-require-imports
import opn = require("opn");
// tslint:disable-next-line:no-require-imports
import request = require('request-promise');
import * as semver from 'semver';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, DialogResponses, IActionContext, parseError } from 'vscode-azureextensionui';
import { PackageManager, ProjectRuntime } from '../constants';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { getFuncExtensionSetting, updateGlobalSetting } from '../ProjectSettings';
import { getFuncPackageManager } from './getFuncPackageManager';
import { getLocalFuncCoreToolsVersion } from './getLocalFuncCoreToolsVersion';
import { getProjectRuntimeFromVersion } from './tryGetLocalRuntimeVersion';
import { updateFuncCoreTools } from './updateFuncCoreTools';

export async function validateFuncCoreToolsIsLatest(): Promise<void> {
    await callWithTelemetryAndErrorHandling('azureFunctions.validateFuncCoreToolsIsLatest', async function (this: IActionContext): Promise<void> {
        this.suppressErrorDisplay = true;
        this.properties.isActivationEvent = 'true';
        const settingKey: string = 'showCoreToolsWarning';
        if (getFuncExtensionSetting<boolean>(settingKey)) {
            const localVersion: string | null = await getLocalFuncCoreToolsVersion();
            if (!localVersion) {
                return;
            }
            this.properties.localVersion = localVersion;

            const projectRuntime: ProjectRuntime | undefined = getProjectRuntimeFromVersion(localVersion);
            if (projectRuntime === undefined) {
                return;
            }

            const packageManager: PackageManager | undefined = await getFuncPackageManager(true /* isFuncInstalled */);
            const newestVersion: string | undefined = await getNewestFunctionRuntimeVersion(packageManager, projectRuntime, this);
            if (!newestVersion) {
                return;
            }

            if (semver.gt(newestVersion, localVersion)) {
                let message: string = localize(
                    'azFunc.outdatedFunctionRuntime',
                    'Update your Azure Functions Core Tools ({0}) to the latest ({1}) for the best experience.',
                    localVersion,
                    newestVersion
                );
                const v2: string = localize('v2BreakingChanges', 'v2 is in preview and may have breaking changes (which are automatically applied to Azure).');
                if (projectRuntime === ProjectRuntime.beta) {
                    message += ` ${v2}`;
                }
                const update: vscode.MessageItem = { title: 'Update' };
                let result: vscode.MessageItem;

                do {
                    result = packageManager !== undefined ? await ext.ui.showWarningMessage(message, update, DialogResponses.learnMore, DialogResponses.dontWarnAgain) :
                        await ext.ui.showWarningMessage(message, DialogResponses.learnMore, DialogResponses.dontWarnAgain);
                    if (result === DialogResponses.learnMore) {
                        await opn('https://aka.ms/azFuncOutdated');
                    } else if (result === update) {
                        // tslint:disable-next-line:no-non-null-assertion
                        await updateFuncCoreTools(packageManager!, projectRuntime);
                    } else if (result === DialogResponses.dontWarnAgain) {
                        await updateGlobalSetting(settingKey, false);
                    }
                }
                while (result === DialogResponses.learnMore);
            }
        }
    });
}

async function getNewestFunctionRuntimeVersion(packageManager: PackageManager | undefined, projectRuntime: ProjectRuntime, actionContext: IActionContext): Promise<string | undefined> {
    try {
        if (packageManager === PackageManager.brew) {
            const brewRegistryUri: string = 'https://aka.ms/AA1t7go';
            const brewInfo: string = await <Thenable<string>>request(brewRegistryUri);
            const matches: RegExpMatchArray | null = brewInfo.match(/version\s+["']([^"']+)["']/i);
            if (matches && matches.length > 1) {
                return matches[1];
            }
        } else {
            const npmRegistryUri: string = 'https://aka.ms/W2mvv3';
            type distTags = { core: string, docker: string, latest: string };
            const distTags: distTags = <distTags>JSON.parse(await <Thenable<string>>request(npmRegistryUri));
            switch (projectRuntime) {
                case ProjectRuntime.one:
                    return distTags.latest;
                case ProjectRuntime.beta:
                    return distTags.core;
                default:
            }
        }
    } catch (error) {
        actionContext.properties.latestRuntimeError = parseError(error).message;
    }

    return undefined;
}
