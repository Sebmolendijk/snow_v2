var AppUtils = Class.create();
AppUtils.prototype = {
    initialize: function() {
    },

    //---------------------------------------------------------------
    // Log messages in system log
    log: function(msg) {
        gs.info(msg);
    },

    //---------------------------------------------------------------
    // Function used to add delay during execution
    sleep: function(ms) {
        var endSleep = new GlideDuration().getNumericValue() + ms;
        while ( new GlideDuration().getNumericValue() < endSleep) {
         //wait 
        }

        return;
    },

    //---------------------------------------------------------------
    // This function build the ServiceNow REST message to get the Sentinel incients
    buildRESTMessageV2: function(environment, skipToken, method, filter, incidentId, body) {

        // Get app properties for API call
        var subscription = environment.subscription;
        var resourceGroup = environment.resource_group;
        var workspace = environment.workspace;
        var apiVersion = gs.getProperty('x_mioms_azsentinel.apiVersion');
        var apiUrl = gs.getProperty('x_mioms_azsentinel.apiUrl');

        if(incidentId)  {
            if(incidentId.includes('/entities') || incidentId.includes('/alerts')) {
                apiVersion = '2019-01-01-preview'; // alerts and entities only available through the preview version
            }
        }


        // Compose API endpoint
        var endpoint =  apiUrl + '/subscriptions/' + subscription + '/resourceGroups/' + resourceGroup + '/providers/Microsoft.OperationalInsights/workspaces/' + workspace + '/providers/Microsoft.SecurityInsights/incidents?';
        var token = this.getAccessToken(environment);


        request = new sn_ws.RESTMessageV2();

        // Default method is GET
        if(!method) {
            method = 'get';
        }
        request.setHttpMethod(method);
        
        if(filter) {

            request.setQueryParameter('$filter', filter);

        }
        if(incidentId) {
            // asking for specific incident or for incident's comments
            endpoint = endpoint.replace('incidents?', 'incidents/' + incidentId + '?');
        }

        if(skipToken) { 
            request.setQueryParameter('$skipToken', skipToken);
        }
        if(body) {
            request.setRequestBody(JSON.stringify(body));
        }
        
        request.setEndpoint(endpoint);
        request.setRequestHeader('Content-Type','application/json;odata=verbose');
        request.setRequestHeader("Accept","application/json");
        request.setRequestHeader('Authorization','Bearer ' + token.getAccessToken());

        request.setQueryParameter('api-version', apiVersion);
        
        

        return request;

    },

    //---------------------------------------------------------------
    // Return skiptoken when more results to fetch during the API call
    getSkipToken: function(nextLink) {
        var skipToken = nextLink.split('&');
        skipToken = skipToken[skipToken.length -1].replace('$skipToken=', ''); //contains skipToken only

        return skipToken;
    },

    //---------------------------------------------------------------
    // Request access token using the saved application OAuth application
    getAccessToken: function(environment) {
        var apiUrl = gs.getProperty('x_mioms_azsentinel.apiUrl');
        var oAuthClient = new sn_auth.GlideOAuthClient();
        var params = {grant_type:"client_credentials",resource:apiUrl};
        var tokenResponse = oAuthClient.requestToken(environment.oauth_provider,global.JSON.stringify(params)); //using the Oauth provider specified in the config table
        

        return tokenResponse.getToken();
    },

    //---------------------------------------------------------------
    //Generate a new uuid
    newUuid: function()
    {
        var seed = Date.now();
        var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (seed + Math.random() * 16) % 16 | 0;
            seed = Math.floor(seed/16);

            return (c === 'x' ? r : r & (0x3|0x8)).toString(16);
        });

        return uuid;
    },

    //---------------------------------------------------------------
    //Return the incident environment ID, based on the value provided in the Description setion
    getEnvironmentId: function(incident) {
	    var environmentId = '';
        var myObj = new GlideRecord('x_mioms_azsentinel_incident_metadata');
	
        myObj.addQuery('incident_id', incident.sys_id);
        myObj.query();

        if(myObj.next() && myObj.getValue('environment_id')) {
		    environmentId = myObj.getValue('environment_id');
        }
        else { //fallback attempt to use the environment ID from description, on the last line
            var ennIdDesc = incident.description.split('\n');
            ennIdDesc = ennIdDesc.pop();

            if(ennIdDesc.split(':')[0].trim().toLowerCase() == 'environmentid') {
                environmentId = ennIdDesc.split(':')[1].trim(); // extracts environment ID from description last line
            }
            else {
                throw {'type': 'getEnvironmentIdNotFound', 'message': 'AppUtils / getEnvironmentId: environment not found for incident ' + incident.sys_id};
            }
        }
        
        return environmentId;
    },

    //---------------------------------------------------------------
    // Returns the last creation or update sync from the sentinelUtils table
    getLastSync: function(property, environment) {

        var myObj = new GlideRecord('x_mioms_azsentinel_workspaces_configuration');
        var lastSync;

        myObj.addQuery('sys_id', environment.sys_id);
        myObj.query();

        if(myObj.next()) {            
            //lastSync = myObj.value;
            lastSync = myObj[property.toLowerCase()];

            if(!lastSync) { // if value not populated, go back 30 days ago
                var date = new Date();
                date.setDate(date.getDate() - 30);
                lastSync = date.toISOString();
                this.updateLastSync(property, lastSync, environment);
            }

        }
        else {
            throw {'type': 'getLastSync', 'message': 'AppUtils / getLastSync: Error while getting ' + property + '\nProperty not found.'};
        }
        
        return lastSync;
    },

    //---------------------------------------------------------------
    // Updates newIncidentsLastSync
    updateLastSync: function(property, date, environment) {

        var myObj = new GlideRecord('x_mioms_azsentinel_workspaces_configuration');
        var now = (new Date()).toISOString();
        if(date) {
            now = date;
        }

        myObj.addQuery('sys_id', environment.sys_id);
        myObj.query();

        if(myObj.next()) {            
            myObj.setValue(property.toLowerCase(), now);
            myObj.update();

            this.log('Environment ' + myObj.environment_name + ' - Updating ' + property + '\nNew value: ' + myObj[property.toLowerCase()]);

        }
        else {
            throw {'type': 'updateLastSync', 'message': 'AppUtils / updateLastSync: Error while updating ' + property};
        }
    },

    //---------------------------------------------------------------
    // Function to get all instances to collect the incidents from.
    // Workspaces configuration are stored in the "x_mioms_azsentinel_workspaces_configuration" (Workspaces Configuration) table
    getSentinelWorkspaces: function() {
        var gr = new GlideRecord('x_mioms_azsentinel_workspaces_configuration');
        gr.addQuery('enabled', 'yes');
        gr.query();
        var configs = [];

        while (gr.next()) {
            var temp = {
                "caller_id": gr.getValue('caller_id'),
                "description": gr.getValue('description'),
                "environment_id": gr.getValue('sys_id'),
                "environment_name": gr.getValue('environment_name'),
                "filter": gr.getValue('filter'),
                'modifiedIncidentsLastSync': gr.getValue('modifiedIncidentsLastSync'),
                'newIncidentsLastSync': gr.getValue('newIncidentsLastSync'),
                "oauth_provider": gr.getValue('oauth_provider'),
                "resource_group": gr.getValue('resource_group'),
                "subscription": gr.getValue('subscription'),
                "sys_id": gr.getValue('sys_id'),
                "workspace": gr.getValue('workspace')
                
            };
            configs.push(temp);
        }

        return configs;
    },
    //---------------------------------------------------------------
    // Function comparing Sentinel and ServiceNow incidents and returning differences
    compareChanges: function(sentinelIncident, snowIncident) {
        var status = gs.getProperty('x_mioms_azsentinel.statusField');
        var severity = gs.getProperty('x_mioms_azsentinel.severityField');
        var changes = {};
        var appUtils = new AppUtils();

        if(sentinelIncident.status != appUtils.getSentinelState(snowIncident[status].toString())) {
            changes.statusSentinel = sentinelIncident.status;
            changes.statusSnow = snowIncident[status].toString();
        } 

        if(sentinelIncident.severity != appUtils.getSentinelSeverity(snowIncident[severity].toString())) {
            changes.severitySentinel = sentinelIncident.severity;
            changes.severitySnow = snowIncident[severity].toString();
        }

        //If values, convert to lower case
        if(sentinelIncident.owner.userPrincipalName) {
            sentinelIncident.owner.userPrincipalName = sentinelIncident.owner.userPrincipalName.toLowerCase();
            
        }

        if(sentinelIncident.owner.userPrincipalName != snowIncident.assigned_to.email.toString().toLowerCase()) {
            
            if(sentinelIncident.owner.userPrincipalName == null && snowIncident.assigned_to.email.toString().length == 0) {
                // no change
            }

            else {
                changes.ownerSentinel = sentinelIncident.owner.userPrincipalName; 
                changes.ownerSnow = snowIncident.assigned_to.email.toString();
            }
        }

        var incidentMetadata = this.getIncidentMetadata(snowIncident.sys_id.toString());
        // Check if new alerts
        if(incidentMetadata) {
            if(incidentMetadata.alerts_nbr < sentinelIncident.additionalData.alertsCount){
                changes.newAlerts = sentinelIncident.additionalData.alertsCount - incidentMetadata.alerts_nbr;
            }
        }
        else {
            //if no metadata record for the incident, create it
            var environmentId = appUtils.getEnvironmentId(snowIncident);
            this.setIncidentMetadata(snowIncident.sys_id.toString(), sentinelIncident.additionalData.alertsCount, 0, environmentId);
        }


        return changes;
    },

    //---------------------------------------------------------------
    // Returns Sentinel severity, based on the passed ServiceNow severity
    getSentinelSeverity: function(sev) {
		var myObj = new GlideRecord('x_mioms_azsentinel_servicenow_severity_to_sentinel');
        myObj.addQuery('servicenow_severity', sev.toString());
        myObj.query();

        if(myObj.next()) {
            var sentinelSev = myObj.sentinel_severity;
            return sentinelSev;
        }
		else {
            throw {'type': 'getSentinelSeverityError', 'message': 'getSentinelSeverity\nNo matching Sentinel Severity in table ServiceNow Severity to Sentinel, for severity value: ' + sev + '\nCannot find the ServiceNow severity to apply.'};
        }
    },

    //---------------------------------------------------------------
    // Returns ServiceNow severity, based on the passed Sentinel severity
    getServiceNowSeverity: function(sev) {
		var myObj = new GlideRecord('x_mioms_azsentinel_sentinel_severity_to_servicenow');
        myObj.addQuery('sentinel_severity', sev.toString());
        myObj.query();

        if(myObj.next()) {
            var serviceNowSev = parseInt(myObj.servicenow_severity);
            return serviceNowSev;
        }
		else {
            throw {'type': 'getServiceNowSeverityError', 'message': 'getServiceNowSeverity\nNo matching Sentinel Severity in table Sentinel Severity to ServiceNow, for severity value: ' + sev + '\nCannot find the ServiceNow severity to apply.'};
        }
    },

    //---------------------------------------------------------------
    // Returns Sentinel state, based on the passed ServiceNow state
    getSentinelState: function(state) {
		var myObj = new GlideRecord('x_mioms_azsentinel_servicenow_state_to_sentinel');
        myObj.addQuery('servicenow_state', state.toString());
        myObj.query();

        if(myObj.next()) {
            var sentinelState = myObj.sentinel_state;
            return sentinelState;
        }
		else {
            throw {'type': 'getSentinelStateError', 'message': 'getSentinelState\nNo matching Sentinel State in table ServiceNow State to Sentinel, for state value: ' + state + '\nCannot find the Sentinel state to apply.'};
        }
    },

    //---------------------------------------------------------------
    // Returns ServiceNow state, based on the passed Sentinel state
    getServiceNowState: function(state) {
		var myObj = new GlideRecord('x_mioms_azsentinel_sentinel_state_to_servicenow');
        myObj.addQuery('sentinel_state', state.toString());
        myObj.query();

        if(myObj.next()) {
            var serviceNowState = parseInt(myObj.servicenow_state);
            return serviceNowState;
        }
		else {
            throw {'type': 'getServiceNowStateError', 'message': 'getServiceNowState\nNo matching ServiceNow State in table Sentinel State to ServiceNow, for state value: ' + state + '\nCannot find the ServiceNow state to apply.'};
        }
    },

    //--------------------------------------------------------------------
    // Return incident metadata record
    getIncidentMetadata: function(incidentId) {
        var myObj = new GlideRecord('x_mioms_azsentinel_incident_metadata');
        myObj.addQuery('incident_id', incidentId);
        myObj.query();

        if(myObj.next()) {
            return myObj;
        }
        else {
            return null;
        }
    },


    //--------------------------------------------------------------------
    // Create record in reference table
    setIncidentMetadata: function(incidentId, alertsNbr, entitiesNbr, environmentId) {
        var myObj = new GlideRecord('x_mioms_azsentinel_incident_metadata');
        myObj.addQuery('incident_id', incidentId);
        myObj.query();

        if(!myObj.next()) {
            try {
                myObj.incident_id = incidentId;
                myObj.alerts_nbr = alertsNbr;
                myObj.entities_nbr = entitiesNbr;
                myObj.environment_id = environmentId;
                var record = myObj.insert();

                return record;
            }
            catch(ex) {
                var message = ex.message;
                appUtils.log('ERROR inserting incident_metadata: ' + message);
            }
        }
        else {
            try {
                myObj.alerts_nbr = alertsNbr;
                myObj.entities_nbr = entitiesNbr;
                if(myObj.environment_id.length == 0) {
                    myObj.environment_id = environmentId;
                }
                var record = myObj.update();
                
                return record;
            }
            catch(ex) {
                var message = ex.message;
                appUtils.log('ERROR updating incident_metadata: ' + message);
            }

        }
    },

    //--------------------------------------------------------------------
    // Return the corresponding closing code value for the other system
    getClosureCode: function(sentinelCode, snowCode, source) {
		var myObj = new GlideRecord('x_mioms_azsentinel_closure_classification');
        
        // To return ServiceNow code
        if(source.toLowerCase() == 'sentinel') {
            myObj.addEncodedQuery('sentinelcode=' + sentinelCode + '^sourceissentinel=true');
            
        }
        // To return Sentinel code
        else {
            myObj.addQuery('servicenowcode', snowCode.toString());
        }
        
        myObj.query();

        if(myObj.next()) {
            var closureCode;

            if(source.toLowerCase() == 'sentinel') {
                closureCode = myObj.servicenowcode;
            }
            else {
                closureCode = myObj.sentinelcode;
            }
            return closureCode;
        }
		else {
            //throw {'type': 'getClosureCode', 'message': 'getClosureCode\nNo matching Closure code for sentinelCode: ' + sentinelCode + ', snowCode: '+ snowCode + '\nSource: ' + source};
            if(source.toLowerCase() == 'sentinel') {
                return 'Closed/Resolved By Caller';
            }
            else {
                return 'Undetermined';
            }
        }
    },

    type: 'AppUtils'
};

