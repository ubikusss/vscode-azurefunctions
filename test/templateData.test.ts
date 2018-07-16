/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IHookCallbackContext } from 'mocha';
import { JavaProjectCreator } from '../src/commands/createNewProject/JavaProjectCreator';
import { JavaScriptProjectCreator } from '../src/commands/createNewProject/JavaScriptProjectCreator';
import { ProjectLanguage, ProjectRuntime, TemplateFilter } from '../src/constants';
import { IFunctionTemplate } from '../src/templates/IFunctionTemplate';
import { getTemplateData, TemplateData } from '../src/templates/TemplateData';

let backupTemplateData: TemplateData;
let funcPortalTemplateData: TemplateData | undefined;

// tslint:disable-next-line:no-function-expression
suiteSetup(async function (this: IHookCallbackContext): Promise<void> {
    this.timeout(30 * 1000);
    backupTemplateData = <TemplateData>(await getTemplateData(undefined));
    funcPortalTemplateData = <TemplateData>(await getTemplateData(undefined));
    // https://github.com/Microsoft/vscode-azurefunctions/issues/334
});

suite('Template Data Tests', async () => {
    test('Valid templates count', async () => {
        if (funcPortalTemplateData) {
            await validateTemplateData(funcPortalTemplateData);
        } else {
            assert.fail('Failed to find templates from functions portal.');
        }

        await validateTemplateData(backupTemplateData);
    });
});

async function validateTemplateData(templateData: TemplateData): Promise<void> {
    const jsTemplates: IFunctionTemplate[] = await templateData.getTemplates(ProjectLanguage.JavaScript, JavaScriptProjectCreator.defaultRuntime, TemplateFilter.Verified);
    assert.equal(jsTemplates.length, 8, 'Unexpected JavaScript templates count.');

    const javaTemplates: IFunctionTemplate[] = await templateData.getTemplates(ProjectLanguage.Java, JavaProjectCreator.defaultRuntime, TemplateFilter.Verified);
    assert.equal(javaTemplates.length, 4, 'Unexpected Java templates count.');

    const cSharpTemplates: IFunctionTemplate[] = await templateData.getTemplates(ProjectLanguage.CSharp, ProjectRuntime.one, TemplateFilter.Verified);
    assert.equal(cSharpTemplates.length, 4, 'Unexpected CSharp (.NET Framework) templates count.');

    const cSharpTemplatesv2: IFunctionTemplate[] = await templateData.getTemplates(ProjectLanguage.CSharp, ProjectRuntime.beta, TemplateFilter.Verified);
    assert.equal(cSharpTemplatesv2.length, 4, 'Unexpected CSharp (.NET Core) templates count.');
}
