var SentinelIncidents = Class.create();
SentinelIncidents.prototype = {
    initialize: function() {
    },

    //---------------------------------------------------------------
    // Return Sentinel incidents, based on the filter
    getSentinelIncidents: function (environment, id, operation) {

        var filter = null;
        var lastSync = null;
        var customFilter = environment.filter;
        var appUtils = new AppUtils();

        if(!id) {
            if(operation === 'update') {
                lastSync = appUtils.getLastSync('modifiedIncidentsLastSync', environment); //returns last sync from sentinelUtils table
                filter = '(properties/lastModifiedTimeUtc gt '+ lastSync + ')';
            }
            else { // searching for new incidents
                lastSync = appUtils.getLastSync('newIncidentsLastSync', environment);
                filter = '(properties/createdTimeUtc gt '+ lastSync + ')';
            }

            // If there is a custom filter added in the app system properties, in addition to the time
            if(customFilter) {
                filter += ' and ' + customFilter;
            }
        }
        var hasNext = false;
        var incidents = [];
        var page = 0;    

        // Prepare request
        var pagedRequest = appUtils.buildRESTMessageV2(environment, null, 'get', filter, id);

        do {    
            // Request Sentinel incidents
            var pagedResponse = pagedRequest.execute();
            var pagedResponseBody = pagedResponse.getBody();
            var pagedhttpStatus = pagedResponse.getStatusCode();
            var pagedObj = JSON.parse(pagedResponseBody);

            if(pagedhttpStatus == 200) {
                // when successful connection, update last sync
                if(pagedObj.value) {
                    incidents = incidents.concat(pagedObj.value);
                }
                else {
                    //one incident only
                    incidents = incidents.concat(pagedObj);
                }
            }
            else {
                throw {'type': 'getSentinelIncidents', 'message': pagedhttpStatus + '; ' + pagedResponseBody};
            }


            if (pagedObj['nextLink']) { // if true, more incidents available

                hasNext = true;
                var skip = appUtils.getSkipToken(pagedObj['nextLink']);
                pagedRequest = appUtils.buildRESTMessageV2(environment, skip, 'get', filter); 
                page++;
            }
            else {
                hasNext = false;
            }

        }while (hasNext);
        
        return incidents;
        
    },

    //---------------------------------------------------------------
    // Create new ServiceNow incidents
    createIncidents: function (environment, incidents) {

        var callerId = environment.caller_id;
        var incidentTable = gs.getProperty('x_557806_microsoft.incidentTableName');
        var incidentUniqueKey = gs.getProperty('x_557806_microsoft.incidentUniqueKey');
        var status = gs.getProperty('x_557806_microsoft.statusField');
        var severity = gs.getProperty('x_557806_microsoft.severityField');
        var createdIncidents = 0;
        var myObj;
        var appUtils = new AppUtils();
        var entitiesUtils = new Entities();
        var alertsUtils = new Alerts();
        var customMapping = new CustomMapping();

        for (var i = 0; i < incidents.length; i++) {
            try {
                myObj = new GlideRecord(incidentTable);

                myObj.addQuery(incidentUniqueKey, incidents[i].name);
                myObj.query();

                if(!myObj.next()) {
                    myObj.initialize();
                    myObj.short_description = incidents[i].properties.title + ' - Incident number: ' + incidents[i].properties.incidentNumber;
                    myObj.description = 'Environment: ' + environment.environment_name + '\nAzure Sentinel incident: ' + incidents[i].properties.incidentNumber + '\nDescription: ' + incidents[i].properties.description + '\nProducts: ' + incidents[i].properties.additionalData.alertProductNames.join() + '\nTactics: ' + incidents[i].properties.additionalData.tactics.join() + '\nIncident link: ' + incidents[i].properties.incidentUrl + '\nEnvironmentID: ' + environment.sys_id;

                    myObj[severity] = appUtils.getServiceNowSeverity(incidents[i].properties.severity); // get the corresponding severity

                    myObj[status] = appUtils.getServiceNowState(incidents[i].properties.status); // get the corresponding status
                    if(incidents[i].properties.status.toLowerCase() == 'closed') {
                        var incidentClosureCode = incidents[i].properties.classification + '-' + incidents[i].properties.classificationReason;

                        myObj.close_code.value = appUtils.getClosureCode(incidentClosureCode, null, 'sentinel');
                        myObj.close_notes = 'Incident was already closed in Sentinel. \nIncident classification: ' + incidentClosureCode + '\nClose comment: ' + incidents[i].properties.classificationComment;
                    }

                    // If owner email empty, use UPN
                    if(incidents[i].properties.owner.email) {
                        myObj.assigned_to = incidents[i].properties.owner.email;
                    }
                    else {
                        myObj.assigned_to = incidents[i].properties.owner.userPrincipalName;
                    }
                    
                    // Correlation id is used to link the SNOW incident to Sentinel incident
                    myObj.setValue(incidentUniqueKey, incidents[i].name);
                    myObj.caller_id = callerId;
                    
                    // record contains the snow incident id and incident is saved in the database
                    try {
                        var record = myObj.insert();
                        createdIncidents++;
                    }
                    catch(ex) {
                        var message = ex.message;
                        appUtils.log('ERROR inserting incident: ' + message);
                    }

                    // Add Sentinel incident url link in work notes
                    myObj = new GlideRecord(incidentTable);
                    myObj.get(record);
                    myObj.setWorkflow(false);
                    myObj.work_notes = "[code]<div class=\"snow\"><a href='" + incidents[i].properties.incidentUrl + "' target='_blank'>Azure Sentinel incident link</a></div>[/code]";
                    myObj.update();

                    // Add incident alerts details
                    var incidentAlerts = alertsUtils.getIncidentAlerts(environment, incidents[i].name, 'json');
                    if(incidentAlerts.length > 0) {    
                        var html = alertsUtils.alertsToHtmlTable(incidentAlerts);
                        if(html) {
                            myObj.setWorkflow(false);
                            myObj.work_notes = '[code]<h2>Alerts</h2>' + html + '[/code]';
                            myObj.update();
                        }
                    }
                    else {
                        myObj.work_notes = '[code]<h2>No Alerts returned by the API</h2>[/code]';
                        myObj.update();
                }

                    // Add incident entities to Snow
                    var incidentEntities =  entitiesUtils.getIncidentEntities(environment, incidents[i].name, 'json');
                    
                    // Create Incident metadata related record
                    var incidentMetadata = appUtils.setIncidentMetadata(myObj.sys_id, incidentAlerts.length, incidentEntities.length, environment.sys_id);


                    // custom mapping
                    customMapping.setCustomMapping(incidents[i],incidentAlerts, incidentEntities, environment);

                    if(incidentEntities.length > 0) {
                        var html = entitiesUtils.entitiesToHtmlTable(incidentEntities);
                        if(html) {
                            myObj.setWorkflow(false);
                            myObj.work_notes = '[code]<h2>Entities</h2>' + html + '[/code]';
                            myObj.update();
                        }
                    }
                    else {
                            myObj.work_notes = '[code]<h2>No Entities returned by the API</h2>[/code]';
                            myObj.update();
                    }
                    //Add Sentinel comments to work notes
                    var comments = this.getIncidentComments(environment, incidents[i].name);
                    if(comments) {
                        comments.forEach(function (comment){
                            myObj.work_notes = '[code]<div class="snow"><b>CreatedTimeUtc: </b>' + comment.properties.createdTimeUtc + '<br><b>Author: </b>' + comment.properties.author.name + '(' + comment.properties.author.userPrincipalName + ')' + '<p><b>Message:</b><br>' + comment.properties.message + '</p></div>[/code]';
                            myObj.update();
                        });

                    }

                    // Adds ServiceNow incident number in Sentinel tags
                    var labelIncidentId = [{
                        "labelName": myObj.number.toString(),
                        "labelType": "User"
                    }];
                    var properties = incidents[i].properties;
                    properties.labels = labelIncidentId;
                    this.updateSentinelIncident(environment, incidents[i].name, properties);
                    
                    // Adds SNOW incident link in Sentinel
                    try {
                        var incidentUrl = this.createUrlForObject(incidentTable, record);
                        var msg = '<div class="snow">' + incidentUrl + '</div>';
                        var httpStatus = this.addIncidentComments(environment, incidents[i].name, msg);
                        if(httpStatus != 201) {
                            appUtils.log('ERROR: incident ' + myObj.number  + '\n' + httpStatus + ' - Comment not added to Sentinel\n' + msg);
                        }

                    }
                    catch (ex) {
                        var message = ex.message;
                        appUtils.log('Environment: ' + environment.environment_name + '- incident:' + incidents[i].name + ' - error in: createIncidents / adding SNOW incident link to Sentinel' + '\n' + message);
                    }
                    
                }
            }
            catch(err) {
                appUtils.log('Environment: ' + environment.environment_name + '- incident:' + incidents[i].name + ' - error in: createIncidents ' + '\n' + err.message);
            }
        }

        return createdIncidents;

    },

    //Function to update Sentinel incidents at creation, by adding labels with the incident number
    updateSentinelIncident: function (environment, incidentId, properties) {
        var appUtils = new AppUtils();

        var incident = this.getSentinelIncidents(environment, incidentId)[0]; // getSentinelIncidents returns an array of one element
        incident.properties.status = properties.status;
        if(incident.properties.status.toLowerCase() == 'closed') {
            incident.properties.classification = properties.classification; //Sentinel requires reason when closing incident
            incident.properties.classificationReason = properties.classificationReason;
            incident.properties.classificationComment = properties.classificationComment;
        }
        else {
            incident.properties.classification = null;
            incident.properties.classificationReason = null;
            incident.properties.classificationComment = null;
        }

        incident.properties.severity = properties.severity;
        if(properties.owner) {
            //Sentinel API's order of preference will prefer objectId over userPrincipalName if it is not null.
            incident.properties.owner.objectId = null;
            incident.properties.owner.userPrincipalName = properties.owner.userPrincipalName;
        }
        else {
            incident.properties.owner = {
                "objectId": null,
                "email": null,
                "assignedTo": null,
                "userPrincipalName": null
            };
        }
        
        if(incident.properties.labels.length > 0) {
            incident.properties.labels = incident.properties.labels.concat(properties.labels);
            // Dedup array
            var temp = incident.properties.labels;
            temp = temp.map(function(i){return i.labelName;});
            temp = temp.filter(function(item, index) {return temp.indexOf(item) === index;});
            incident.properties.labels = temp.map(function(i){
                return {"labelName": i, "labelType": "User"};
            });
        }
        else {
            incident.properties.labels = properties.labels;
        }
        

        var body = {
            "etag": incident.etag,
            "properties": incident.properties
        };

        var request = appUtils.buildRESTMessageV2(environment, null, 'put', null, incidentId, body);
        try {
            var response = request.execute();
            var httpStatus = response.getStatusCode();
        }
        catch(ex) {
            appUtils.log('ERROR updateSentinelIncidents - ' + JSON.stringify(response) + ' - ' + message);
        }
        return httpStatus;
    },

    // Update existing Sentinel incidents in ServiceNow
    updateChangedIncidents: function(environment, modifiedIncidents, modifiedLastSync) {
    
        var incidentTable = gs.getProperty('x_557806_microsoft.incidentTableName');
        var incidentUniqueKey = gs.getProperty('x_557806_microsoft.incidentUniqueKey');
        var status = gs.getProperty('x_557806_microsoft.statusField');
        var severity = gs.getProperty('x_557806_microsoft.severityField');
        var updatedIncidents = 0;
        var addedComments;
        var myObj;
        var changes;
        var newComments = [];
        var appUtils = new AppUtils();
        var entitiesUtils = new Entities();
        var alertsUtils = new Alerts();
        var customMapping = new CustomMapping();


        for (var i = 0; i < modifiedIncidents.length; i++) {

            addedComments = 0;
            myObj = new GlideRecord(incidentTable);
            myObj.addQuery(incidentUniqueKey, modifiedIncidents[i].name);
            myObj.query();

            if(myObj.next()) {
                
                changes = appUtils.compareChanges(modifiedIncidents[i].properties, myObj);

                // Add incident entities to Snow if new entities have been added after incident creation
                var incidentMetadataEntities = appUtils.getIncidentMetadata(myObj.sys_id.toString());
                // Check if new entities
                if(incidentMetadataEntities) {
                                  
                    var incidentEntities =  entitiesUtils.getIncidentEntities(environment, modifiedIncidents[i].name, 'json');
                    
                    if(incidentEntities.length > parseInt(incidentMetadataEntities.entities_nbr))
                    {    
                        appUtils.log('Incident ' + myObj.number + ' updated number of entities.\nPrevious value: ' + incidentMetadataEntities.entities_nbr + '\nNew value: ' + incidentEntities.length);
                        var htmlEntities = entitiesUtils.entitiesToHtmlTable(incidentEntities);
                        if(htmlEntities) {
                            myObj.setWorkflow(false);
                            myObj.work_notes = '[code]<h2>Entities (updated)</h2>' + htmlEntities + '[/code]';
                            myObj.update();
                        }
                        //update incident metadata value
                        appUtils.setIncidentMetadata(myObj.sys_id.toString(), incidentMetadataEntities.alerts_nbr, incidentEntities.length, environment.sys_id);
                    }
                }

                if(Object.keys(changes).length > 0) {
                    
                    
                    if(changes.hasOwnProperty('severitySentinel')) {
                        myObj[severity] = appUtils.getServiceNowSeverity(modifiedIncidents[i].properties.severity);
                    }

                    if(changes.hasOwnProperty('statusSentinel')) { 
                        myObj[status] = appUtils.getServiceNowState(modifiedIncidents[i].properties.status);
                        if(modifiedIncidents[i].properties.status.toLowerCase() == 'closed') {
                            var incidentClosureCode = modifiedIncidents[i].properties.classification + '-' + modifiedIncidents[i].properties.classificationReason;

                            myObj.close_code.value = appUtils.getClosureCode(incidentClosureCode, null, 'sentinel');
                            myObj.close_notes = 'Incident was already closed in Sentinel. \nIncident classification: ' + incidentClosureCode + '\nClose comment: ' + modifiedIncidents[i].properties.classificationComment;
                        
                        }
                    }

                    if(changes.hasOwnProperty('ownerSentinel')) {
                        if(modifiedIncidents[i].properties.owner.userPrincipalName) {
                            myObj.assigned_to = modifiedIncidents[i].properties.owner.userPrincipalName;
                        }
                    }

                    
                    if(changes.hasOwnProperty('newAlerts')) {
                        // add new alerts sync
                        incidentMetadataEntities = appUtils.getIncidentMetadata(myObj.sys_id.toString());
                        var incidentAlerts = alertsUtils.getIncidentAlerts(environment, modifiedIncidents[i].name, 'json', modifiedLastSync);
                        if(incidentAlerts.length > 0 && incidentAlerts.length > parseInt(incidentMetadataEntities.alerts_nbr)) {
                            
                            //get only new alerts
                            incidentAlerts.sort(function(a, b){
                                var x = new Date(a.end);
                                var y = new Date(b.end);
                                if (x < y) {return -1;}
                                if (x > y) {return 1;}
                                return 0;
                            });

                            var newAlerts = incidentAlerts.slice(parseInt(incidentMetadataEntities.alerts_nbr)); //start index at new alerts


                            appUtils.log('Incident ' + myObj.number + ' updated number of alerts.\nPrevious value: ' + incidentMetadataEntities.alerts_nbr + '\nNew value: ' + incidentAlerts.length);
                            //add filter for newest alerts
                            var htmlAlerts = alertsUtils.alertsToHtmlTable(newAlerts);
                            if(htmlAlerts) {
                                myObj.setWorkflow(false);
                                myObj.work_notes = '[code]<h2>Alerts (updated)</h2>' + htmlAlerts + '[/code]';
                                myObj.update();

                            }
                        }
                        //entities

                        // Custom mapping
                        customMapping.setCustomMapping(modifiedIncidents[i],incidentAlerts, incidentEntities, environment);

                        // Update metadata counters
                        var incidentMetadata = appUtils.setIncidentMetadata(myObj.sys_id, incidentAlerts.length, incidentEntities.length, environment.sys_id);

                    }

                    try {

                        myObj.setWorkflow(false);
                        myObj.update();
                        updatedIncidents++;
                        //appUtils.log('Incident ' + myObj.number + ' has been updated\nChanges: ' + JSON.stringify(changes));

                        
                    }
                    catch(ex) {
                        var message = ex.message;
                        appUtils.log('ERROR: Incident ' + myObj.number + ' update failed\n' + message);
                    }

                }
                
                //returns added comments since last sync
                newComments = this.getIncidentComments(environment, modifiedIncidents[i].name, modifiedLastSync);
                if(newComments.length > 0) {
                    newComments.forEach(function (comment) {
                        myObj.work_notes = '[code]<div class="snow"><b>CreatedTimeUtc: </b>' + comment.properties.createdTimeUtc + '<br><b>Author: </b>' + comment.properties.author.name + '(' + comment.properties.author.userPrincipalName + ')' + '<p><b>Message:</b><br>' + comment.properties.message + '</p></div>[/code]';
                        myObj.update();
                        addedComments++;
                    });
                }

                if(addedComments > 0 || updatedIncidents > 0) {
                    appUtils.log('Incident ' + myObj.number + ' has been updated\nChanges: ' + JSON.stringify(changes) + '\nNew comments: ' + addedComments);
                }
                
            }
            else {
                var incidentToCreate = []; 
                incidentToCreate.push(modifiedIncidents[i]);
                this.createIncidents(environment, incidentToCreate);
            }
        }
        
        return updatedIncidents;
    },


    // Creates an url to the created ServiceNow record
    createUrlForObject: function(table_name, sys_id){
        var url = gs.getProperty('glide.servlet.uri') + 'nav_to.do?uri=%2F' + table_name + '.do?sys_id=' + sys_id;
        return "<a href=" +  url + ">ServiceNow incident link</a>";
    },

    //---------------------------------------------------------------
    // Get comments to incident
    getIncidentComments: function (environment, incidentId, lastSync) {
        var appUtils = new AppUtils();
        var hasNext = false;
        var comments = [];
        var filteredComments = [];
        var filter = null;

        if(lastSync) {

            filter = '(properties/createdTimeUtc gt ' + lastSync + ')';
        }

        // Prepare request
        incidentId = incidentId + '/comments';
        var pagedRequest = appUtils.buildRESTMessageV2(environment, null, 'get', filter, incidentId);

        do {    
            // Request Sentinel incidents
            var pagedResponse = pagedRequest.execute();
            var pagedResponseBody = pagedResponse.getBody();
            var pagedhttpStatus = pagedResponse.getStatusCode();
            var pagedObj = JSON.parse(pagedResponseBody);

            if(pagedhttpStatus == 200) {
                
                comments = comments.concat(pagedObj.value);
            }
            else {
                appUtils.log('Error code: ' + pagedhttpStatus + '\nMessage:\n' + pagedResponseBody);
            }


            if (pagedObj['nextLink']) { // if true, more incidents available

                hasNext = true;
                var skip = appUtils.getSkipToken(pagedObj['nextLink']);
                pagedRequest = appUtils.buildRESTMessageV2(environment, skip, 'get', filter, incidentId); 
            }
            else {
                hasNext = false;
            }

        }while (hasNext);
        
        // Filters out the comments created by SNOW. This app adds "(Work notes)" when adding a comment to Sentinel
        filteredComments = comments.filter(function (comment) {
            return comment.properties.message.toLowerCase().indexOf('<div class="snow">') === -1;
        });

        // Sort comments by creation date
        if(filteredComments) {
            filteredComments.sort(function(a, b){
                var x = new Date(a.properties.createdTimeUtc);
                var y = new Date(b.properties.createdTimeUtc);
                if (x < y) {return -1;}
                if (x > y) {return 1;}
                return 0;
            });
            filteredComments.reverse();
        }

        return filteredComments;
    },

    //---------------------------------------------------------------
    // Add comments to incident
    addIncidentComments: function (environment, incidentId, comment) {
        var appUtils = new AppUtils();
        var msg = {
            "properties": {
                "message": comment
            }     
        };
        var uuid = appUtils.newUuid();

        // Building endpoint based on incident id + comments + comment uuid
        incidentId = incidentId + '/comments/' + uuid;
        var request = appUtils.buildRESTMessageV2(environment, null, 'put', null, incidentId, msg);

        var response = request.execute();
        var httpStatus = response.getStatusCode();

        return httpStatus;
    },

    type: 'SentinelIncidents'
};
