(function executeRule(current, previous) {
	var status = gs.getProperty('x_mioms_azsentinel.statusField');
    var severity = gs.getProperty('x_mioms_azsentinel.severityField');
    var incidentUniqueKey = gs.getProperty('x_mioms_azsentinel.incidentUniqueKey');
    var appUtils = new AppUtils();
    var sentinelIncidents = new SentinelIncidents();

	var gr = new GlideRecord('x_mioms_azsentinel_workspaces_configuration');

    try {

        var environmentId = appUtils.getEnvironmentId(current);
        gr.addQuery('sys_id', environmentId);
        gr.query();
        if(gr.next()) {
            var environment = gr;
        }
        else {
            throw {'type': 'UnknownEnvironmentId', 'message': 'Business rule - update_changes_to_sentinel \nEnvironment: ' + environmentId + ' not found!'};
        }

    
        var myObj = current;
        var incident = sentinelIncidents.getSentinelIncidents(environment, myObj[incidentUniqueKey]);
        var changes = appUtils.compareChanges(incident[0].properties, myObj); //changes is an object with all changes
        var properties = incident[0].properties;
        
        if (Object.keys(changes).length > 0) { //if at least one change

            if(changes.hasOwnProperty('severitySentinel')) { //severity must be updated in Sentinel
                properties.severity = (appUtils.getSentinelSeverity(myObj[severity])).toString();					

            }
            
            if(changes.hasOwnProperty('statusSentinel')) { //status must be updated in Sentinel
                properties.status = (appUtils.getSentinelState(myObj[status])).toString();

                if(properties.status.toLowerCase() == 'closed') {
                    var closureCode = appUtils.getClosureCode(null, myObj.close_code, 'servicenow');

                    if(closureCode != 'Undetermined') {
                        properties.classification = closureCode.split('-')[0];
                        properties.classificationReason = closureCode.split('-')[1];
                    }
                    else {
                        properties.classification = 'Undetermined';
                    }
                    properties.classificationComment = 'Incident resolved in ServiceNow. Closure code: ' + myObj.close_code + ' - ' + myObj.close_notes;
                }
            }
            
            if(changes.hasOwnProperty('ownerSentinel')) { //owner must be updated in Sentinel
                if(!myObj.assigned_to.email.toString()) {
                    properties.owner = null;
                }
                else {
                    properties.owner.userPrincipalName = myObj.assigned_to.email.toString();
                }
            }
            
            var httpStatus = sentinelIncidents.updateSentinelIncident(environment, myObj[incidentUniqueKey], properties); //update Sentinel incident

            if(httpStatus == 200) {
                appUtils.log(httpStatus + ' - Sentinel Incident ' + incident[0].properties.incidentNumber + ' has been updated after snow updates.\nChanges: ' + JSON.stringify(changes));
            }
            else if(httpStatus == 409) {
                //In case of concurrency(etag conflict), retry max 5 times after a 1 sec sleep
                for (var retry = 0; retry < 5; retry++) {
                    appUtils.sleep(1000); //wait 1000 millisecconds
                    httpStatus = sentinelIncidents.updateSentinelIncident(environment, myObj[incidentUniqueKey], properties);
                    
                    if(httpStatus == 200) {
                        appUtils.log(httpStatus + ' - Sentinel Incident ' + incident[0].properties.incidentNumber + ' has been updated after snow updates.\nChanges: ' + JSON.stringify(changes));
                    }
                    else {
                        appUtils.log(httpStatus + ' - Sentinel Incident ' + incident[0].properties.incidentNumber + ' snow updates retry ' + retry + ' failed.\nHttpStatus: ' + httpStatus + '\nChanges: ' + JSON.stringify(changes));
                    }
                }
            }
            else {
                throw {'type': 'updateSentinelIncident', 'message': 'Business rule - update_changes_to_sentinelenvironment / updateSentinelIncident failed.\n' + httpStatus + '\nRequested changes: ' + JSON.stringify(changes)};
            }

        }

    }
    catch (ex) {
        var message = ex.message;
        appUtils.log('ERROR updating incident (business rule) ' + current.number + '\n' + message);
            }
})(current, previous);