const coordinate = {type:'string',description:'Latitude,longitude, for example 37.7749,-122.4194'};
export const toolManifest = {
  name:'uber', version:1, transport:'CLI', output:'JSON on stdout; JSON errors on stderr and nonzero exit status',
  authentication:'Run uber login, approve on another device, then uber auth complete. Runtime refresh is automatic.',
  tools:[
    {name:'resolve',command:'uber resolve --id <id> --provider <provider> [--context PICKUP|DROPOFF]',description:'Resolve a place identifier returned by search to coordinates and addresses.',inputSchema:{type:'object',properties:{id:{type:'string',minLength:1},provider:{type:'string',minLength:1},context:{type:'string',enum:['PICKUP','DROPOFF']}},required:['id','provider'],additionalProperties:false}},
    {name:'search',command:'uber search --query <query> --near <near> [--context PICKUP|DROPOFF]',description:'Find Uber places by name or address. Use a nearby coordinate to rank results.',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1},near:coordinate,context:{type:'string',enum:['PICKUP','DROPOFF']}},required:['query','near'],additionalProperties:false}},
    {name:'status',command:'uber status',description:'Read current trip state and active orders without booking or cancelling.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'products',command:'uber products --from <from> --to <to> [--via <coordinate>]',description:'List ride products for a route without booking.',inputSchema:{type:'object',properties:{from:coordinate,to:coordinate,via:{type:'array',items:coordinate}},required:['from','to'],additionalProperties:false}},
    {name:'quote',command:'uber quote --from <from> --to <to> [--via <coordinate>]',description:'Get server-issued fare estimates and product options. Quote prices expire; this does not book a ride.',inputSchema:{type:'object',properties:{from:coordinate,to:coordinate,via:{type:'array',items:coordinate}},required:['from','to'],additionalProperties:false}},
    {name:'auth_status',command:'uber auth status',description:'Inspect local login state without revealing tokens.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  ],
};
