/** Fruit Battle reference circuit (flat, single module), used to validate automatic block partitioning. */
export const FRUIT_FILE = 'fruit_battle.v';

export const FRUIT_SOURCE = `module top (
    input [31:0] seed,
    input [11:0] workers_a, workers_b,
    input [1:0] shears_field_a, shears_field_b,
    input [1:0] gift_box_field_a, gift_box_field_b,
    output [7:0] crop_map,
    output [3:0] score_a, score_b,
    output [1:0] game_result
);
    wire [4:0] worker_total_a, worker_total_b;
    wire allocation_a_valid, allocation_b_valid;
    wire tools_a_valid, tools_b_valid;
    wire result_valid;
    reg [7:0] field_owner;
    wire [3:0] shears_mask_a, shears_mask_b, gift_box_mask_a, gift_box_mask_b;
    wire [3:0] occupied_a, occupied_b;
    wire [15:0] efficiency_a, efficiency_b;
    wire [3:0] base_score_a, base_score_b;
    wire [31:0] seed_x1, seed_x2, seed_x3;
    wire [7:0] crop_points;

    assign seed_x1 = seed ^ (seed << 13);
    assign seed_x2 = seed_x1 ^ (seed_x1 >> 17);
    assign seed_x3 = seed_x2 ^ (seed_x2 << 5);
    assign crop_map = seed_x3[7:0];
    assign crop_points[1:0] = crop_map[1] ? crop_map[1:0] : 2'd1;
    assign crop_points[3:2] = crop_map[3] ? crop_map[3:2] : 2'd1;
    assign crop_points[5:4] = crop_map[5] ? crop_map[5:4] : 2'd1;
    assign crop_points[7:6] = crop_map[7] ? crop_map[7:6] : 2'd1;

    assign worker_total_a = {2'b0, workers_a[2:0]} + {2'b0, workers_a[5:3]} +
                            {2'b0, workers_a[8:6]} + {2'b0, workers_a[11:9]};
    assign worker_total_b = {2'b0, workers_b[2:0]} + {2'b0, workers_b[5:3]} +
                            {2'b0, workers_b[8:6]} + {2'b0, workers_b[11:9]};
    assign allocation_a_valid = (worker_total_a == 5'd6);
    assign allocation_b_valid = (worker_total_b == 5'd6);

    assign occupied_a = {|workers_a[11:9], |workers_a[8:6],
                         |workers_a[5:3], |workers_a[2:0]};
    assign occupied_b = {|workers_b[11:9], |workers_b[8:6],
                         |workers_b[5:3], |workers_b[2:0]};
    assign shears_mask_a = 4'b0001 << shears_field_a;
    assign shears_mask_b = 4'b0001 << shears_field_b;
    assign gift_box_mask_a = 4'b0001 << gift_box_field_a;
    assign gift_box_mask_b = 4'b0001 << gift_box_field_b;
    assign tools_a_valid = (|(occupied_a & shears_mask_a)) & (|(occupied_a & gift_box_mask_a));
    assign tools_b_valid = (|(occupied_b & shears_mask_b)) & (|(occupied_b & gift_box_mask_b));
    assign result_valid = allocation_a_valid & allocation_b_valid &
                          tools_a_valid & tools_b_valid;

    assign efficiency_a[3:0] = {1'b0, workers_a[2:0]} + (shears_mask_a[0] ? 4'd2 : 4'd0);
    assign efficiency_a[7:4] = {1'b0, workers_a[5:3]} + (shears_mask_a[1] ? 4'd2 : 4'd0);
    assign efficiency_a[11:8] = {1'b0, workers_a[8:6]} + (shears_mask_a[2] ? 4'd2 : 4'd0);
    assign efficiency_a[15:12] = {1'b0, workers_a[11:9]} + (shears_mask_a[3] ? 4'd2 : 4'd0);
    assign efficiency_b[3:0] = {1'b0, workers_b[2:0]} + (shears_mask_b[0] ? 4'd2 : 4'd0);
    assign efficiency_b[7:4] = {1'b0, workers_b[5:3]} + (shears_mask_b[1] ? 4'd2 : 4'd0);
    assign efficiency_b[11:8] = {1'b0, workers_b[8:6]} + (shears_mask_b[2] ? 4'd2 : 4'd0);
    assign efficiency_b[15:12] = {1'b0, workers_b[11:9]} + (shears_mask_b[3] ? 4'd2 : 4'd0);
    always @(*) begin
        field_owner = 8'b0;
        if (result_valid) begin
            field_owner[0] = (efficiency_a[3:0] > efficiency_b[3:0]);
            field_owner[1] = (efficiency_a[7:4] > efficiency_b[7:4]);
            field_owner[2] = (efficiency_a[11:8] > efficiency_b[11:8]);
            field_owner[3] = (efficiency_a[15:12] > efficiency_b[15:12]);
            field_owner[4] = (efficiency_b[3:0] > efficiency_a[3:0]);
            field_owner[5] = (efficiency_b[7:4] > efficiency_a[7:4]);
            field_owner[6] = (efficiency_b[11:8] > efficiency_a[11:8]);
            field_owner[7] = (efficiency_b[15:12] > efficiency_a[15:12]);
        end
    end
    assign base_score_a = (field_owner[0] ? {2'b0, crop_points[1:0]} : 4'd0) +
                          (field_owner[1] ? {2'b0, crop_points[3:2]} : 4'd0) +
                          (field_owner[2] ? {2'b0, crop_points[5:4]} : 4'd0) +
                          (field_owner[3] ? {2'b0, crop_points[7:6]} : 4'd0);
    assign base_score_b = (field_owner[4] ? {2'b0, crop_points[1:0]} : 4'd0) +
                          (field_owner[5] ? {2'b0, crop_points[3:2]} : 4'd0) +
                          (field_owner[6] ? {2'b0, crop_points[5:4]} : 4'd0) +
                          (field_owner[7] ? {2'b0, crop_points[7:6]} : 4'd0);

    assign score_a = base_score_a + ((|(field_owner[3:0] & gift_box_mask_a)) ? 4'd2 : 4'd0);
    assign score_b = base_score_b + ((|(field_owner[7:4] & gift_box_mask_b)) ? 4'd2 : 4'd0);
    assign game_result = !result_valid ? 2'b00 : (score_a > score_b) ? 2'b01 :
                                              (score_a < score_b) ? 2'b10 : 2'b11;
endmodule
`;
