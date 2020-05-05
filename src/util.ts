import { Octokit } from '@octokit/rest';
import * as core from '@actions/core'

export function to_bool(value: string | number | boolean | null | undefined): boolean {
    if (value === 'true') {
        return true;
    }

    return typeof value === 'string'
        ? !!+value   // we parse string to integer first
        : !!value;
}

export interface PullRequest {
    [key: string]: any;
    number: number;
    html_url?: string;
    body?: string;
}

export async function sync_labels(octokit: Octokit, pr: PullRequest, to_remove: string[], to_add: string[]) {
    core.debug(`adding labels '${to_add}', removing labels ${to_remove}`);

    core.debug(`LABELS ARE ${JSON.stringify(pr.labels, null, 2)}`);

    var labels: string[] = [];
    var changed = false;
    for (const label of pr.labels) {
        if (!to_remove.includes(label.name)) {
            labels.push(label.name);
        } else {
            changed = true;
        }
    }

    for (const add of to_add) {
        if (!labels.includes(add)) {
            labels.push(add);
            changed = true;
        }
    }

    if (!changed) {
        core.info("No labels to change");
        return;
    }

    core.debug(`changings labels from '${pr.labels}' to '${labels}'`);

    await octokit.issues.replaceAllLabels({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
        labels: labels,
    });
}