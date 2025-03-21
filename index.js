const axios = require('axios')
const core = require('@actions/core');
const fs = require('fs');
crypto = require("crypto");

// Load Configuration
const veracodeWebhook = core.getInput('VERACODE_WEBHOOK');
const id = core.getInput('VERACODE_SECRET_ID');
const key = core.getInput('VERACODE_SECRET_ID_KEY');
const region = core.getInput('REGION');
const pullReport = core.getInput('pull-report');
const targetid = core.getInput('VERACODE_TARGET_ID');
const authType = core.getInput('AUTH_TYPE');
const clientId = core.getInput('CLIENT_ID');
const clientSecret = core.getInput('CLIENT_SECRET');
const authUrl = core.getInput('AUTH_URL');
const scope = core.getInput('AUTH_SCOPE');
const headerSystemAccount = core.getInput('SYSTEM_ACCOUNT');
const headerSystemAccountName = core.getInput('SYSTEM_ACCOUNT_NAME');

const preFix = "VERACODE-HMAC-SHA-256";
const verStr = "vcode_request_version_1";

let host = "api.veracode.com";
let urlCorePrefix = "/dae/api/core-api/webhook";
let urlTCSPrefix = "/dae/api/tcs-api/api/v1";

if(region === "eu") {
    host = "api.veracode.eu";
}

let hmac256 = async (data, key) => {
    let hash = require('crypto').createHmac('sha256', key).update(data);
    // no format = Buffer / byte array
    return hash.digest();
}

let getByteArray = (hex) => {
    let bytes = [];

    for(let i = 0; i < hex.length-1; i+=2){
        bytes.push(parseInt(hex.substr(i, 2), 16));
    }

    // signed 8-bit integer array (byte array)
    return Int8Array.from(bytes);
}

let generateHeader = async (url, method) => {

    let data = `id=${id}&host=${host}&url=${url}&method=${method}`;
    let timestamp = (new Date().getTime()).toString();
    let nonce = require('crypto').randomBytes(16).toString('hex');

    // calculate signature
    let hashedNonce = await hmac256(getByteArray(nonce), getByteArray(key));
    let hashedTimestamp = await hmac256(buffer(timestamp), getByteArray(hex(hashedNonce)));
    let hashedVerStr = await hmac256(buffer(verStr), getByteArray(hex(hashedTimestamp)));
    let signature = hex(await hmac256(buffer(data), getByteArray(hex(hashedVerStr))));

    return `${preFix} id=${id},ts=${timestamp},nonce=${nonce},sig=${signature}`;
}

const wait = function (milliseconds) {
    return new Promise((resolve) => {
        if (typeof milliseconds !== 'number') {
            throw new Error('milliseconds not a number');
        }
        setTimeout(() => resolve("done!"), milliseconds)
    });
};

// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest#Converting_a_digest_to_a_hex_string
let hex = (buffer) => Array.from(new Uint8Array(buffer)).map(n => n.toString(16).padStart(2, "0")).join("");

let buffer = (string) => new TextEncoder("utf-8").encode(string);

async function run() {
    try {

        // Setup general variables
        const pollTimeout = 60000; // Polling the scan status every 60 seconds
        let status = 100; // 100 = Queued
        let scanId = undefined;
        let anaylsisResponse;
        let token = '';

        if(authType === "CLIENT_CREDENTIALS") {
            if(!clientId || !clientSecret || !authUrl || !scope || !headerSystemAccount || !headerSystemAccountName || !targetid) {
                core.setFailed(`Please provide all necessary parameters for the Client Credentials Auth Type.`);
                return
            }

            try {
                let profileUrl = urlTCSPrefix + "/analysis_profiles?target_id=" + targetid;
                let authHeaderAnalysisProfile = await generateHeader(profileUrl, "GET");
                anaylsisResponse = await axios.get("https://"+`${host}${profileUrl}`, {headers: {'Authorization': authHeaderAnalysisProfile}});
            } catch(error) {
                errorMsg = error.toString()
                core.setFailed(`Could not get analysis profile. Reason: ${errorMsg}.`);
                return
            }
            
            try{
                // Get the access token
                let clientData = `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=${scope}`;
                let headers = {
                    "Content-Type": "application/x-www-form-urlencoded"
                }

                const tokenResponse = await axios.post("https://"+`${authUrl}/token`, clientData, {headers: headers});
                token = tokenResponse.data.access_token;
            } catch(error) {
                errorMsg = error.toString()
                core.setFailed(`Could not get token. Reason: ${errorMsg}.`);
                return
            }

            try {
                // set anaylsis profile parameters            
                let parameterUrl = urlTCSPrefix + "/analysis_profiles/" + anaylsisResponse.data._embedded.analysis_profiles[0].analysis_profile_id + "/parameter_authentications";
                let parameterHeaderAnalysisProfile = await generateHeader(parameterUrl, "PUT");
                let paramData = [
                    {
                        "title": "Auth",
                        "type": "HTTP_HEADER",
                        "key": "Authorization",
                        "value": "Bearer " + token
                    },
                    {
                        "title": "SystemAccount",
                        "type": "HTTP_HEADER",
                        "key": headerSystemAccountName,
                        "value": headerSystemAccount
                    }
                ]
                const response = await axios.put("https://"+`${host}${parameterUrl}`, paramData, {headers: {'Authorization': parameterHeaderAnalysisProfile}});
            } catch(error) {
                errorMsg = error.toString()
                core.setFailed(`Could not set parameter authentications. Reason: ${errorMsg}.`);
                return
            }
        }

        console.log(`Sending Webhook to URL ${host}${urlCorePrefix} for ${veracodeWebhook}`);

        // Start the Security Scan
        try {
            let url = urlCorePrefix + "/" + veracodeWebhook + "/scan";
            let VERACODE_AUTH_HEADER = await generateHeader(url, "POST");
            const response = await axios.post("https://"+`${host}${url}`, "", {headers: {'Authorization': VERACODE_AUTH_HEADER}});
            scanId = response.data.data.scanId;
        } catch(error) {
            errorMsg = error.toString()
            core.setFailed(`Could not start Scan for Webhook ${veracodeWebhook}. Reason: ${errorMsg}.`);
            return
        }

        // Check if the scan was correctly started
        if (!scanId) {
            core.setFailed(`Could not start Scan for Webhook ${veracodeWebhook}.`);
            return
        }

        console.log(`Started Scan for Webhook ${veracodeWebhook}. Scan ID is ${scanId}.`)

        // Check if the action should wait for the report and download it
        if (pullReport === 'false') {
            console.log(`Skipping the download of the scan report as pull-report='${pullReport}'.`);
            return
        }

        // Wait until the scan has finished
        while (status <= 101) {
            console.log(`Scan Status currently is ${status} (101 = Running)`);

            // Only poll every minute
            await wait(pollTimeout);

            // Refresh status
            try {
                let method = "GET";
                let url = urlPrefix+"/"+`${veracodeWebhook}/scans/${scanId}/status`;

                let VERACODE_AUTH_HEADER = await generateHeader(url, method);
                const response = await axios.get("https://"+`${host}${url}`, {headers: {'Authorization': VERACODE_AUTH_HEADER}});
                status = response.data.data.status.status_code;
            } catch(error) {
                errorMsg = error.response.data.message
                core.setFailed(`Retreiving Scan Status failed for Webhook ${veracodeWebhook}. Reason: ${errorMsg}.`);
                return
            }

        }

        console.log(`Scan finished with status ${status}.`)

        // Download the JUnit Report
        let junitReport = undefined;
        try {
            let method = "GET";
            let url = urlPrefix+"/"+`${veracodeWebhook}/scans/${scanId}/report/junit`;
            let VERACODE_AUTH_HEADER = await generateHeader(url, method);

            const response = await axios.get("https://"+`${host}${url}`, {headers: {'Authorization': VERACODE_AUTH_HEADER}})
            junitReport = response.data;
        } catch(error) {
            errorMsg = error.response.data.message
            core.setFailed(`Downloading Report failed for Webhook ${veracodeWebhook}. Reason: ${errorMsg}.`);
            return
        }

        fs.writeFile('report.xml', junitReport, function(error) {
            if (error) {
                core.setFailed(`Writing the Report failed for Webhook ${veracodeWebhook}. Reason: ${error}`);
            }
        });

        console.log('Downloaded Report to report.xml');

    } catch (error) {
        core.setFailed(error.message);
        return
    }
}

run();
